import type Database from "libsql";
import { insertTransaction, accountHasTransactions } from "./transactions.js";
import { fromMinorUnits, toMinorUnits } from "../../currency.js";
import { todayIso } from "../../lib/date.js";
import { normalizeMaskedAccountNumber } from "./account-match.js";
import { buildPatch, type PatchField } from "../../lib/patch.js";

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

interface NetWorth {
  assets: number;
  liabilities: number;
  net_worth: number;
}

interface PeriodTotals {
  income: number;
  expenses: number;
}

export function findAccountById(db: Database.Database, id: string): AccountRow | null {
  return (db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as AccountRow | undefined) ?? null;
}

export function renameAccount(db: Database.Database, id: string, name: string): number {
  return db.prepare(`UPDATE accounts SET name = ? WHERE id = ?`).run(name, id).changes;
}

/** Idempotently insert a top-level type root (id = type name, parent_id = null). */
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
 * Enforces the hierarchy invariants: top-level roots have parent_id null and
 * id == type; children need an existing same-type parent (its top-level root
 * auto-bootstraps, intermediate categories don't) and an id prefixed
 * `parent.id + ':'`. Duplicate id surfaces as code 'ACCOUNT_EXISTS'.
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

interface UpdateAccountMetadataResult {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changed: boolean;
}

const ACCOUNT_PATCH: Record<string, PatchField> = {
  due_day: {},
  statement_day: {},
  points_balance: {},
  account_number_masked: {
    transform: (v) => normalizeMaskedAccountNumber(v as string | null),
  },
  bank_name: {
    transform: (v) => (v == null ? null : String(v).toUpperCase()),
  },
};

/**
 * Returns before/after snapshots of touched fields for a reversible audit
 * record. `metadata` is shallow-merged into the existing metadata_json blob.
 */
export function updateAccountMetadata(
  db: Database.Database,
  id: string,
  patch: UpdateAccountMetadataPatch,
): UpdateAccountMetadataResult {
  const current = findAccountById(db, id);
  if (!current) throw new Error(`Account "${id}" not found.`);

  const { sets, params, before, after } = buildPatch(ACCOUNT_PATCH, current, patch);

  if (patch.metadata !== undefined) {
    const existing = current.metadata_json ? JSON.parse(current.metadata_json) : {};
    const merged = { ...existing, ...patch.metadata };
    sets.push("metadata_json = ?");
    params.push(JSON.stringify(merged));
    before.metadata = existing;
    after.metadata = merged;
  }

  if (sets.length === 0) return { before, after, changed: false };
  params.push(id);
  db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return { before, after, changed: true };
}

interface MergeAccountsResult {
  /** Transaction legs re-pointed from the source account onto the destination. */
  moved: number;
  /** Transactions deleted because re-pointing would have collapsed them into a
   *  degenerate self-transaction (debit == credit). */
  deletedSelfTransactions: number;
}

/** Re-points every transaction leg on `fromId` to `toId`, then deletes the
 *  source account. Refuses if the source still has children. */
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

  const { moved, deletedSelfTransactions } = repointTransactions(db, fromId, toId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(fromId);
  return { moved, deletedSelfTransactions };
}

/** Delete an account only if no transactions reference it AND it has no children. */
export function deleteAccount(db: Database.Database, id: string): void {
  if (accountHasTransactions(db, id)) {
    throw new Error(`Account ${id} still has transactions; merge it first.`);
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

/** Recursive CTE walk over `accounts.parent_id`: root plus every descendant. */
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

// Balance derivations below share one normal-balance rule: asset/expense are
// debit-normal, the rest credit-normal. Amounts are integer minor units;
// decimal fields are derived per the account's own currency exponent.

/** Debit + credit legs of every non-void transaction, one row per leg (`void_of`
 *  rows excluded so a merged mirror never double-counts). */
const TRANSACTION_LEGS = `SELECT debit_account_id  AS acct, amount, date, 'D' AS side FROM transactions WHERE void_of IS NULL
       UNION ALL
       SELECT credit_account_id AS acct, amount, date, 'C' AS side FROM transactions WHERE void_of IS NULL`;

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

/** Per-account balance from the `transactions` table (normal-balance rule above). */
export function getAccountBalancesFromTransactions(
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
         LEFT JOIN (${TRANSACTION_LEGS}) t ON t.acct = a.id
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

export function getNetWorthFromTransactions(db: Database.Database): NetWorth {
  const balances = getAccountBalancesFromTransactions(db);
  let assets = 0;
  let liabilities = 0;
  for (const b of balances) {
    if (b.type === "asset") assets += b.balance;
    else if (b.type === "liability") liabilities += b.balance;
  }
  return { assets, liabilities, net_worth: assets - liabilities };
}

/**
 * Income (credits − debits) and expenses (debits − credits) over a date range.
 * Grouped by (type, currency) so each currency converts with its own exponent.
 */
export function getPeriodTotalsFromTransactions(
  db: Database.Database,
  from: string,
  to: string,
): PeriodTotals {
  const rows = db
    .prepare(
      `SELECT a.type AS type, a.currency AS currency,
              SUM(CASE WHEN t.side = 'C' THEN t.amount ELSE -t.amount END) AS c_minus_d
         FROM (${TRANSACTION_LEGS}) t
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

/** Subtree balance (root inclusive), grouped by (type, currency) for correct conversion. */
export function getRollupBalanceFromTransactions(db: Database.Database, rootId: string): number {
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
         LEFT JOIN (${TRANSACTION_LEGS}) t ON t.acct = a.id
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
 * Re-point step for `mergeAccounts`. Rows that would become a degenerate
 * self-transaction (one side `fromId`, the other already `toId`) are deleted
 * FIRST — the debit<>credit CHECK forbids that state even transiently — then
 * the remainder is re-pointed. Does not touch the accounts table.
 */
export function repointTransactions(
  db: Database.Database,
  fromId: string,
  toId: string,
): { moved: number; deletedSelfTransactions: number } {
  if (fromId === toId) throw new Error("Cannot re-point transactions to the same account.");

  let moved = 0;
  let deletedSelfTransactions = 0;
  const tx = db.transaction((): void => {
    deletedSelfTransactions = db
      .prepare(
        `DELETE FROM transactions
          WHERE (debit_account_id = ? AND credit_account_id = ?)
             OR (credit_account_id = ? AND debit_account_id = ?)`,
      )
      .run(fromId, toId, fromId, toId).changes;

    const d = db
      .prepare(`UPDATE transactions SET debit_account_id = ? WHERE debit_account_id = ?`)
      .run(toId, fromId).changes;
    const c = db
      .prepare(`UPDATE transactions SET credit_account_id = ? WHERE credit_account_id = ?`)
      .run(toId, fromId).changes;
    moved = d + c;
  });
  tx();
  return { moved, deletedSelfTransactions };
}

interface AdjustViaTransactionOpts {
  accountId: string;
  /** New desired balance in the account's currency, decimal, natural sign. */
  targetAmount: number;
  reason: string;
  /** ISO YYYY-MM-DD. Defaults to today. */
  date?: string;
}

interface AdjustViaTransactionResult {
  /** Id of the balancing transaction, or null when already at target (no-op). */
  transactionId: string | null;
  /** target − current, decimal, natural sign. 0 on no-op. */
  delta: number;
}

/**
 * Moves an account to `targetAmount` by posting one balancing transaction
 * against `equity:adjustments`. Delta math is integer minor units (no float
 * drift); a zero delta is a no-op.
 */
export function adjustAccountBalanceViaTransaction(
  db: Database.Database,
  opts: AdjustViaTransactionOpts,
): AdjustViaTransactionResult {
  const account = findAccountById(db, opts.accountId);
  if (!account) throw new Error(`Account "${opts.accountId}" not found.`);

  const target = Number(opts.targetAmount);
  if (!Number.isFinite(target)) {
    throw new Error(`targetAmount must be a number, got ${JSON.stringify(opts.targetAmount)}.`);
  }

  const currency = account.currency || "THB";
  const currentMinor =
    getAccountBalancesFromTransactions(db).find((b) => b.id === account.id)?.balance_minor ?? 0;
  const targetMinor = toMinorUnits(target, currency);
  const deltaMinor = targetMinor - currentMinor;
  if (deltaMinor === 0) return { transactionId: null, delta: 0 };

  const amount = Math.abs(deltaMinor);
  const debitNormal = account.type === "asset" || account.type === "expense";
  const accountIsDebit = (debitNormal && deltaMinor > 0) || (!debitNormal && deltaMinor < 0);
  const debitAccountId = accountIsDebit ? account.id : EQUITY_ADJUST_ID;
  const creditAccountId = accountIsDebit ? EQUITY_ADJUST_ID : account.id;

  const date =
    opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : todayIso();
  const reason = String(opts.reason || "Balance adjustment").trim();

  let transactionId = "";
  const tx = db.transaction((): void => {
    if (!findAccountById(db, EQUITY_ADJUST_ID)) {
      ensureStructuralAccount(db, "equity:adjustments");
    }
    transactionId = insertTransaction(db, {
      date,
      description: reason,
      debit_account_id: debitAccountId,
      credit_account_id: creditAccountId,
      amount,
      currency,
    }).id;
  });
  tx();

  return { transactionId, delta: fromMinorUnits(deltaMinor, currency) };
}
