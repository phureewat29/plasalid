import type Database from "libsql";
import { insertTransfer, accountHasTransfers } from "./transfers.js";
import { fromMinorUnits, toMinorUnits } from "../../currency.js";

export type AccountType = "asset" | "liability" | "income" | "expense" | "equity";

export const TOP_LEVEL_TYPES: ReadonlyArray<AccountType> = [
  "asset", "liability", "income", "expense", "equity",
];

const TYPE_ROOT_NAME: Record<AccountType, string> = {
  asset: "Assets",
  liability: "Liabilities",
  income: "Income",
  expense: "Expenses",
  equity: "Equity",
};

export interface AccountRow {
  id: string;
  name: string;
  type: AccountType;
  parent_id: string | null;
  subtype: string | null;
  bank_name: string | null;
  account_number_masked: string | null;
  currency: string;
  due_day: number | null;
  statement_day: number | null;
  points_balance: number | null;
  metadata_json: string | null;
  pii_flag: number;
  has_question: number;
  created_at: string;
}

export interface AccountBalance extends AccountRow {
  balance: number;
}

export interface NetWorth {
  assets: number;
  liabilities: number;
  net_worth: number;
}

export interface PeriodTotals {
  income: number;
  expenses: number;
}

export function findAccountById(db: Database.Database, id: string): AccountRow | null {
  return (db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as AccountRow | undefined) ?? null;
}

export function renameAccount(db: Database.Database, id: string, name: string): number {
  return db.prepare(`UPDATE accounts SET name = ? WHERE id = ?`).run(name, id).changes;
}

/**
 * Idempotently insert one of the five top-level type roots (id = type name,
 * parent_id = null). Called by `createAccount` when a child's declared parent
 * is a missing top-level root.
 */
export function ensureTopLevelRoot(db: Database.Database, type: AccountType): void {
  if (findAccountById(db, type)) return;
  db.prepare(
    `INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, NULL)`,
  ).run(type, TYPE_ROOT_NAME[type], type);
}

/**
 * Idempotently insert one of the structural accounts the system auto-creates:
 *  - `expense:uncategorized`  (suspense for unclassifiable expense entries)
 *  - `equity:adjustments`     (balancing side of `adjust_account_balance`)
 *  - `equity:opening-balance` (starting state imports)
 * The top-level root is bootstrapped first when missing.
 */
export function ensureStructuralAccount(
  db: Database.Database,
  id: "expense:uncategorized" | "equity:adjustments" | "equity:opening-balance",
): void {
  if (findAccountById(db, id)) return;
  const [type, leaf] = id.split(":") as [AccountType, string];
  ensureTopLevelRoot(db, type);
  const name = leaf === "uncategorized" ? "Uncategorized"
    : leaf === "adjustments" ? "Adjustments"
    : "Opening Balance";
  db.prepare(
    `INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`,
  ).run(id, name, type, type);
}

export interface CreateAccountInput {
  id: string;
  name: string;
  type: AccountType;
  parent_id?: string | null;
  subtype?: string | null;
  bank_name?: string | null;
  account_number_masked?: string | null;
  currency?: string;
  due_day?: number | null;
  statement_day?: number | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Insert a new account row. Enforces the three hierarchy invariants:
 *   1. Top-level roots: parent_id null, id == type, one of TOP_LEVEL_TYPES.
 *   2. Children: parent_id non-null, parent must exist (the top-level root is
 *      auto-bootstrapped if missing; intermediate categories must be created
 *      explicitly), parent.type must equal input.type, input.id must start with
 *      parent.id + ':'.
 *   3. UNIQUE on id (surfaces as code: 'ACCOUNT_EXISTS').
 */
export function createAccount(db: Database.Database, input: CreateAccountInput): void {
  const bank = input.bank_name ? String(input.bank_name).toUpperCase() : null;
  const maskedNumber = normalizeMaskedAccountNumber(input.account_number_masked);
  const parentId = input.parent_id ?? null;

  if (parentId === null) {
    if (!TOP_LEVEL_TYPES.includes(input.id as AccountType)) {
      throw new Error(
        `Account "${input.id}" has no parent_id; only top-level type roots may have a null parent (one of ${TOP_LEVEL_TYPES.join(", ")}).`,
      );
    }
    if (input.id !== input.type) {
      throw new Error(`Top-level root id "${input.id}" must equal its type "${input.type}".`);
    }
  } else {
    let parent = findAccountById(db, parentId);
    if (!parent) {
      if (TOP_LEVEL_TYPES.includes(parentId as AccountType)) {
        ensureTopLevelRoot(db, parentId as AccountType);
        parent = findAccountById(db, parentId);
      }
    }
    if (!parent) {
      throw new Error(`Parent account "${parentId}" does not exist; create it first.`);
    }
    if (parent.type !== input.type) {
      throw new Error(
        `Account "${input.id}" type "${input.type}" does not match parent "${parentId}" type "${parent.type}".`,
      );
    }
    if (!input.id.startsWith(parent.id + ":")) {
      throw new Error(`Account id "${input.id}" must start with parent id "${parent.id}:".`);
    }
  }

  try {
    db.prepare(
      `INSERT INTO accounts (id, name, type, parent_id, subtype, bank_name, account_number_masked, currency, due_day, statement_day, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.name,
      input.type,
      parentId,
      input.subtype ?? null,
      bank,
      maskedNumber,
      input.currency ?? "THB",
      input.due_day ?? null,
      input.statement_day ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    );
  } catch (err: any) {
    if (String(err.message).includes("UNIQUE")) {
      const dup = new Error(`Account "${input.id}" already exists.`);
      (dup as any).code = "ACCOUNT_EXISTS";
      throw dup;
    }
    throw err;
  }
}

export interface UpdateAccountMetadataPatch {
  due_day?: number | null;
  statement_day?: number | null;
  points_balance?: number | null;
  account_number_masked?: string | null;
  bank_name?: string | null;
  metadata?: Record<string, unknown>;
}

export interface UpdateAccountMetadataResult {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changed: boolean;
}

/**
 * Patch metadata fields on an account. Returns before/after snapshots of the
 * touched fields so callers can persist a reversible audit record. `metadata`
 * is shallow-merged into the existing metadata_json blob.
 */
export function updateAccountMetadata(
  db: Database.Database,
  id: string,
  patch: UpdateAccountMetadataPatch,
): UpdateAccountMetadataResult {
  const current = findAccountById(db, id);
  if (!current) throw new Error(`Account "${id}" not found.`);

  const sets: string[] = [];
  const params: any[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  if (patch.due_day !== undefined) {
    sets.push("due_day = ?"); params.push(patch.due_day);
    before.due_day = current.due_day; after.due_day = patch.due_day;
  }
  if (patch.statement_day !== undefined) {
    sets.push("statement_day = ?"); params.push(patch.statement_day);
    before.statement_day = current.statement_day; after.statement_day = patch.statement_day;
  }
  if (patch.points_balance !== undefined) {
    sets.push("points_balance = ?"); params.push(patch.points_balance);
    before.points_balance = current.points_balance; after.points_balance = patch.points_balance;
  }
  if (patch.account_number_masked !== undefined) {
    const next = normalizeMaskedAccountNumber(patch.account_number_masked);
    sets.push("account_number_masked = ?"); params.push(next);
    before.account_number_masked = current.account_number_masked;
    after.account_number_masked = next;
  }
  if (patch.bank_name !== undefined) {
    const next = patch.bank_name == null ? null : String(patch.bank_name).toUpperCase();
    sets.push("bank_name = ?"); params.push(next);
    before.bank_name = current.bank_name; after.bank_name = next;
  }
  if (patch.metadata) {
    const existing = current.metadata_json ? JSON.parse(current.metadata_json) : {};
    const merged = { ...existing, ...patch.metadata };
    sets.push("metadata_json = ?"); params.push(JSON.stringify(merged));
    before.metadata = existing; after.metadata = merged;
  }

  if (sets.length === 0) return { before, after, changed: false };
  params.push(id);
  db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return { before, after, changed: true };
}

export interface MergeAccountsResult {
  /** Transfer legs re-pointed from the source account onto the destination. */
  moved: number;
  /** Transfers deleted because re-pointing would have collapsed them into a
   *  degenerate self-transfer (debit == credit). */
  deletedSelfTransfers: number;
}

/**
 * Re-point every transfer leg on `fromId` to `toId` (via `repointTransfers`),
 * then delete the source account. Refuses if the source still has children.
 * Returns legs moved and self-transfers deleted.
 */
export function mergeAccounts(
  db: Database.Database,
  fromId: string,
  toId: string,
): MergeAccountsResult {
  if (fromId === toId) throw new Error("Cannot merge an account into itself.");
  const from = findAccountById(db, fromId);
  if (!from) throw new Error(`Source account ${fromId} not found.`);
  const to = findAccountById(db, toId);
  if (!to) throw new Error(`Destination account ${toId} not found.`);

  const childCount = db
    .prepare(`SELECT COUNT(*) AS n FROM accounts WHERE parent_id = ?`)
    .get(fromId) as { n: number };
  if (childCount.n > 0) {
    throw new Error(`Account ${fromId} has ${childCount.n} child account(s); merge or delete them first.`);
  }

  const { moved, deletedSelfTransfers } = repointTransfers(db, fromId, toId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(fromId);
  return { moved, deletedSelfTransfers };
}

/** Delete an account only if no transfers reference it AND it has no children. */
export function deleteAccount(db: Database.Database, id: string): void {
  if (accountHasTransfers(db, id)) {
    throw new Error(`Account ${id} still has transfers; merge it first.`);
  }
  const childCount = db
    .prepare(`SELECT COUNT(*) AS n FROM accounts WHERE parent_id = ?`)
    .get(id) as { n: number };
  if (childCount.n > 0) {
    throw new Error(`Account ${id} has ${childCount.n} child account(s); delete them first.`);
  }
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
}

const EQUITY_ADJUST_ID = "equity:adjustments";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Recursive CTE walk over `accounts.parent_id` returning the root and every
 * descendant. Used by `getRollupBalance` and by hierarchical rendering paths.
 */
export function getAccountSubtree(db: Database.Database, rootId: string): AccountRow[] {
  return db.prepare(
    `WITH RECURSIVE subtree AS (
       SELECT * FROM accounts WHERE id = ?
       UNION ALL
       SELECT a.* FROM accounts a JOIN subtree s ON a.parent_id = s.id
     )
     SELECT * FROM subtree ORDER BY id`,
  ).all(rootId) as AccountRow[];
}

export interface FuzzyAccountMatch {
  account: AccountRow;
  similarity: number;
}

/**
 * Canonical key for an account number, tolerant of a trailing check digit.
 * Statements sometimes print the same account with or without a trailing check
 * digit (`xxx-7652-0` vs `xxx-7652`); both should resolve to one account. Keep
 * digits only, drop the final digit when the run is long enough to carry a
 * separate check digit, and return the last 4.
 *
 *   "••7652"   -> "7652"
 *   "••7652-0" -> "76520" -> "7652"
 *   "1234"     -> "1234"
 */
export function accountNumberKey(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D+/g, "");
  if (!digits) return "";
  const core = digits.length >= 5 ? digits.slice(0, -1) : digits;
  return core.slice(-4);
}

/**
 * Normalize a masked account number for storage so a trailing check digit
 * doesn't split one account into two: `••7652-0` and `••76520` both store as
 * `••7652`. Preserves the leading bullet mask; defaults to `••` when absent.
 */
export function normalizeMaskedAccountNumber(
  masked: string | null | undefined,
): string | null {
  if (masked == null) return null;
  const s = String(masked);
  const key = accountNumberKey(s);
  if (!key) return s;
  const prefix = /^\D+/.exec(s)?.[0] ?? "••";
  return prefix + key;
}

/** Longest digit run in free text, reduced to an account-number key. */
function queryNumberKey(text: string): string {
  const runs = text.match(/\d+/g);
  if (!runs) return "";
  const longest = runs.reduce((a, b) => (b.length > a.length ? b : a));
  return accountNumberKey(longest);
}

/**
 * Rank the chart of accounts by name similarity to a free-text query. Returns
 * matches at or above `threshold`, highest first. Bonus weight when the query
 * is a substring of the name so "ttb saving" still finds "TTB Savings ••1234"
 * even though pure Levenshtein on the full strings is mediocre. A query that
 * carries an account number also matches check-digit-tolerantly against each
 * row's masked number (so "7652-0" still finds the account stored as ••7652);
 * callers still confirm before acting on a fuzzy hit, so a rare same-last-4
 * collision across banks stays recoverable.
 */
export function findAccountsByFuzzyName(
  db: Database.Database,
  query: string,
  threshold = 0.5,
): FuzzyAccountMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qKey = queryNumberKey(q);
  const rows = db.prepare(`SELECT * FROM accounts ORDER BY name`).all() as AccountRow[];
  const out: FuzzyAccountMatch[] = [];
  for (const row of rows) {
    const name = row.name.toLowerCase();
    let score = similarity(q, name);
    if (name.includes(q) || q.includes(name)) score = Math.max(score, 0.85);
    if (qKey) {
      const rowKey = row.account_number_masked
        ? accountNumberKey(row.account_number_masked)
        : queryNumberKey(name);
      if (rowKey && rowKey === qKey) score = Math.max(score, 0.9);
    }
    if (score >= threshold) {
      out.push({ account: row, similarity: Math.round(score * 1000) / 1000 });
    }
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev: number[] = new Array(n + 1);
  const curr: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

// ---------------------------------------------------------------------------
// Balance derivations over the single-row `transfers` table (TigerBeetle-core).
//
// Every transfer contributes a debit leg and a credit leg via the UNION-ALL
// subquery, so account balances fall out of the standard normal-balance rule:
// asset/expense are debit-normal, the rest credit-normal. Amounts are integer
// minor units in the table; decimal fields are derived per the account's own
// currency exponent.
// ---------------------------------------------------------------------------

/** Debit + credit legs of every transfer, one row per leg. Shared by the
 *  transfer-based aggregates below. */
const TRANSFER_LEGS = `SELECT debit_account_id  AS acct, amount, date, 'D' AS side FROM transfers
       UNION ALL
       SELECT credit_account_id AS acct, amount, date, 'C' AS side FROM transfers`;

export interface AccountBalanceMinor extends AccountRow {
  /** Sum of debit legs, minor units. */
  debits_posted: number;
  /** Sum of credit legs, minor units. */
  credits_posted: number;
  /** Natural balance in minor units (normal-balance rule). */
  balance_minor: number;
  /** Natural balance as a decimal (via the account's currency exponent). */
  balance: number;
}

/**
 * Per-account balance from the `transfers` table. Normal-balance rule matches
 * `getAccountBalances`: asset/expense are debit-normal, the rest credit-normal.
 */
export function getAccountBalancesFromTransfers(
  db: Database.Database,
  opts: { type?: AccountType } = {},
): AccountBalanceMinor[] {
  const params: any[] = [];
  const where: string[] = [];
  if (opts.type) {
    where.push("a.type = ?");
    params.push(opts.type);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT a.*,
              COALESCE(SUM(CASE WHEN t.side = 'D' THEN t.amount ELSE 0 END), 0) AS sum_debit,
              COALESCE(SUM(CASE WHEN t.side = 'C' THEN t.amount ELSE 0 END), 0) AS sum_credit
         FROM accounts a
         LEFT JOIN (${TRANSFER_LEGS}) t ON t.acct = a.id
         ${whereSql}
         GROUP BY a.id
         ORDER BY a.type, a.id`,
    )
    .all(...params) as (AccountRow & { sum_debit: number; sum_credit: number })[];

  return rows.map((r) => {
    const debitNormal = r.type === "asset" || r.type === "expense";
    const balance_minor = debitNormal ? r.sum_debit - r.sum_credit : r.sum_credit - r.sum_debit;
    const { sum_debit, sum_credit, ...account } = r;
    return {
      ...(account as AccountRow),
      debits_posted: sum_debit,
      credits_posted: sum_credit,
      balance_minor,
      balance: fromMinorUnits(balance_minor, account.currency),
    };
  });
}

export function getNetWorthFromTransfers(db: Database.Database): NetWorth {
  const balances = getAccountBalancesFromTransfers(db);
  let assets = 0;
  let liabilities = 0;
  for (const b of balances) {
    if (b.type === "asset") assets += b.balance;
    else if (b.type === "liability") liabilities += b.balance;
  }
  return { assets, liabilities, net_worth: assets - liabilities };
}

/**
 * Income (credits − debits on income accounts) and expenses (debits − credits
 * on expense accounts) over a date range, from `transfers`. Grouped by
 * (type, currency) so each currency's minor units convert with the right
 * exponent before summing.
 */
export function getPeriodTotalsFromTransfers(
  db: Database.Database,
  from: string,
  to: string,
): PeriodTotals {
  const rows = db
    .prepare(
      `SELECT a.type AS type, a.currency AS currency,
              SUM(CASE WHEN t.side = 'C' THEN t.amount ELSE -t.amount END) AS c_minus_d
         FROM (${TRANSFER_LEGS}) t
         JOIN accounts a ON a.id = t.acct
         WHERE t.date BETWEEN ? AND ? AND a.type IN ('income', 'expense')
         GROUP BY a.type, a.currency`,
    )
    .all(from, to) as { type: AccountType; currency: string; c_minus_d: number }[];

  let income = 0;
  let expenses = 0;
  for (const r of rows) {
    if (r.type === "income") income += fromMinorUnits(r.c_minus_d, r.currency);
    else if (r.type === "expense") expenses += fromMinorUnits(-r.c_minus_d, r.currency);
  }
  return { income, expenses };
}

/** Subtree balance (root inclusive) from `transfers`, same convention as
 *  `getRollupBalance`. Grouped by (type, currency) for correct conversion. */
export function getRollupBalanceFromTransfers(db: Database.Database, rootId: string): number {
  const subtree = getAccountSubtree(db, rootId);
  if (subtree.length === 0) return 0;
  const ids = subtree.map((a) => a.id);
  const placeholders = ids.map(() => "?").join(",");

  const rows = db
    .prepare(
      `SELECT a.type AS type, a.currency AS currency,
              COALESCE(SUM(CASE WHEN t.side = 'D' THEN t.amount ELSE 0 END), 0) AS sum_debit,
              COALESCE(SUM(CASE WHEN t.side = 'C' THEN t.amount ELSE 0 END), 0) AS sum_credit
         FROM accounts a
         LEFT JOIN (${TRANSFER_LEGS}) t ON t.acct = a.id
         WHERE a.id IN (${placeholders})
         GROUP BY a.type, a.currency`,
    )
    .all(...ids) as { type: AccountType; currency: string; sum_debit: number; sum_credit: number }[];

  let total = 0;
  for (const r of rows) {
    const debitNormal = r.type === "asset" || r.type === "expense";
    const minor = debitNormal ? r.sum_debit - r.sum_credit : r.sum_credit - r.sum_debit;
    total += fromMinorUnits(minor, r.currency);
  }
  return total;
}

/**
 * Transfer-model counterpart of `mergeAccounts`' re-point step. Moves every
 * transfer leg on `fromId` to `toId` across BOTH columns. Because the
 * debit<>credit CHECK forbids a transient self-transfer, rows that would become
 * degenerate (one side is `fromId`, the other already `toId`) are deleted FIRST,
 * then the remainder is re-pointed. Returns legs moved and self-transfers
 * deleted. (Does not touch the accounts table — the caller deletes the source.)
 */
export function repointTransfers(
  db: Database.Database,
  fromId: string,
  toId: string,
): { moved: number; deletedSelfTransfers: number } {
  if (fromId === toId) throw new Error("Cannot re-point transfers to the same account.");

  let moved = 0;
  let deletedSelfTransfers = 0;
  const tx = db.transaction((): void => {
    deletedSelfTransfers = db
      .prepare(
        `DELETE FROM transfers
          WHERE (debit_account_id = ? AND credit_account_id = ?)
             OR (credit_account_id = ? AND debit_account_id = ?)`,
      )
      .run(fromId, toId, fromId, toId).changes;

    const d = db
      .prepare(`UPDATE transfers SET debit_account_id = ? WHERE debit_account_id = ?`)
      .run(toId, fromId).changes;
    const c = db
      .prepare(`UPDATE transfers SET credit_account_id = ? WHERE credit_account_id = ?`)
      .run(toId, fromId).changes;
    moved = d + c;
  });
  tx();
  return { moved, deletedSelfTransfers };
}

export interface AdjustViaTransferOpts {
  accountId: string;
  /** New desired balance in the account's currency, decimal, natural sign. */
  targetAmount: number;
  reason: string;
  /** ISO YYYY-MM-DD. Defaults to today. */
  date?: string;
}

export interface AdjustViaTransferResult {
  /** Id of the balancing transfer, or null when already at target (no-op). */
  transferId: string | null;
  /** target − current, decimal, natural sign. 0 on no-op. */
  delta: number;
}

/**
 * Transfer-model counterpart of `adjustAccountBalance`: move an account to
 * `targetAmount` by posting one balancing transfer against `equity:adjustments`.
 * Delta math is done in integer minor units (no float drift); a zero delta is a
 * no-op. Orientation matches the posting-based version.
 */
export function adjustAccountBalanceViaTransfer(
  db: Database.Database,
  opts: AdjustViaTransferOpts,
): AdjustViaTransferResult {
  const account = findAccountById(db, opts.accountId);
  if (!account) throw new Error(`Account "${opts.accountId}" not found.`);

  const target = Number(opts.targetAmount);
  if (!Number.isFinite(target)) {
    throw new Error(`targetAmount must be a number, got ${JSON.stringify(opts.targetAmount)}.`);
  }

  const currency = account.currency || "THB";
  const currentMinor =
    getAccountBalancesFromTransfers(db).find((b) => b.id === account.id)?.balance_minor ?? 0;
  const targetMinor = toMinorUnits(target, currency);
  const deltaMinor = targetMinor - currentMinor;
  if (deltaMinor === 0) return { transferId: null, delta: 0 };

  const amount = Math.abs(deltaMinor);
  const debitNormal = account.type === "asset" || account.type === "expense";
  const accountIsDebit = (debitNormal && deltaMinor > 0) || (!debitNormal && deltaMinor < 0);
  const debitAccountId = accountIsDebit ? account.id : EQUITY_ADJUST_ID;
  const creditAccountId = accountIsDebit ? EQUITY_ADJUST_ID : account.id;

  const date =
    opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : todayIso();
  const reason = String(opts.reason || "Balance adjustment").trim();

  let transferId = "";
  const tx = db.transaction((): void => {
    if (!findAccountById(db, EQUITY_ADJUST_ID)) {
      ensureStructuralAccount(db, "equity:adjustments");
    }
    transferId = insertTransfer(db, {
      date,
      description: reason,
      debit_account_id: debitAccountId,
      credit_account_id: creditAccountId,
      amount,
      currency,
    }).id;
  });
  tx();

  return { transferId, delta: fromMinorUnits(deltaMinor, currency) };
}
