import type Database from "libsql";

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

/**
 * Balance per account using the natural debit/credit convention:
 *   asset / expense  → debit-normal  → balance = debits − credits
 *   liability / income / equity → credit-normal → balance = credits − debits
 */
export function getAccountBalances(db: Database.Database, opts: { type?: AccountType } = {}): AccountBalance[] {
  const params: any[] = [];
  const where: string[] = [];
  if (opts.type) {
    where.push("a.type = ?");
    params.push(opts.type);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = db.prepare(
    `SELECT a.*,
            COALESCE(SUM(p.debit), 0)  AS sum_debit,
            COALESCE(SUM(p.credit), 0) AS sum_credit
     FROM accounts a
     LEFT JOIN postings p ON p.account_id = a.id
     ${whereSql}
     GROUP BY a.id
     ORDER BY a.type, a.id`,
  ).all(...params) as (AccountRow & { sum_debit: number; sum_credit: number })[];

  return rows.map(r => {
    const debitNormal = r.type === "asset" || r.type === "expense";
    const balance = debitNormal ? r.sum_debit - r.sum_credit : r.sum_credit - r.sum_debit;
    const { sum_debit: _d, sum_credit: _c, ...account } = r;
    return { ...(account as AccountRow), balance };
  });
}

export interface NetWorth {
  assets: number;
  liabilities: number;
  net_worth: number;
}

export function getNetWorth(db: Database.Database): NetWorth {
  const balances = getAccountBalances(db);
  let assets = 0;
  let liabilities = 0;
  for (const b of balances) {
    if (b.type === "asset") assets += b.balance;
    else if (b.type === "liability") liabilities += b.balance;
  }
  return { assets, liabilities, net_worth: assets - liabilities };
}

export interface PeriodTotals {
  income: number;
  expenses: number;
}

export function getPeriodTotals(db: Database.Database, from: string, to: string): PeriodTotals {
  const row = db.prepare(
    `SELECT
        COALESCE(SUM(CASE WHEN a.type = 'income'  THEN p.credit - p.debit ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN a.type = 'expense' THEN p.debit - p.credit ELSE 0 END), 0) AS expenses
     FROM postings p
     JOIN transactions t ON t.id = p.transaction_id
     JOIN accounts a ON a.id = p.account_id
     WHERE t.date BETWEEN ? AND ?`,
  ).get(from, to) as { income: number; expenses: number };
  return { income: row.income, expenses: row.expenses };
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
 *  - `expense:uncategorized`  (suspense for unclassifiable expense postings)
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

/**
 * Re-point every posting on `fromId` to `toId`, then delete the source account.
 * Wrapped in a transaction. Refuses if the source still has children. Returns
 * the number of postings moved.
 */
export function mergeAccounts(db: Database.Database, fromId: string, toId: string): number {
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

  let moved = 0;
  const tx = db.transaction((): void => {
    moved = db
      .prepare(`UPDATE postings SET account_id = ? WHERE account_id = ?`)
      .run(toId, fromId).changes;
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(fromId);
  });
  tx();
  return moved;
}

/** Delete an account only if no postings reference it AND it has no children. */
export function deleteAccount(db: Database.Database, id: string): void {
  const inUse = db
    .prepare(`SELECT 1 FROM postings WHERE account_id = ? LIMIT 1`)
    .get(id);
  if (inUse) {
    throw new Error(`Account ${id} still has postings; merge it first.`);
  }
  const childCount = db
    .prepare(`SELECT COUNT(*) AS n FROM accounts WHERE parent_id = ?`)
    .get(id) as { n: number };
  if (childCount.n > 0) {
    throw new Error(`Account ${id} has ${childCount.n} child account(s); delete them first.`);
  }
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
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

/**
 * Sum the natural balance of every account in a subtree (root inclusive).
 * Uses the same debit-normal / credit-normal convention as `getAccountBalances`.
 */
export function getRollupBalance(db: Database.Database, rootId: string): number {
  const subtree = getAccountSubtree(db, rootId);
  if (subtree.length === 0) return 0;
  const ids = subtree.map(a => a.id);
  const placeholders = ids.map(() => "?").join(",");
  const row = db.prepare(
    `SELECT a.type,
            COALESCE(SUM(p.debit), 0)  AS sum_debit,
            COALESCE(SUM(p.credit), 0) AS sum_credit
     FROM accounts a
     LEFT JOIN postings p ON p.account_id = a.id
     WHERE a.id IN (${placeholders})
     GROUP BY a.type`,
  ).all(...ids) as { type: AccountType; sum_debit: number; sum_credit: number }[];

  let total = 0;
  for (const r of row) {
    const debitNormal = r.type === "asset" || r.type === "expense";
    total += debitNormal ? r.sum_debit - r.sum_credit : r.sum_credit - r.sum_debit;
  }
  return total;
}

export interface SimilarAccountPair {
  a: AccountRow;
  b: AccountRow;
  similarity: number;
}

/**
 * Pairwise Levenshtein similarity over `accounts.name`. Returns pairs above the
 * threshold (0-1, where 1 = identical), sorted highest first. Quadratic in the
 * number of accounts, but fine for the small N a personal chart of accounts holds.
 */
export function findSimilarAccounts(db: Database.Database, threshold = 0.85): SimilarAccountPair[] {
  const rows = db.prepare(`SELECT * FROM accounts ORDER BY name`).all() as AccountRow[];
  const pairs: SimilarAccountPair[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const sim = similarity(rows[i].name.toLowerCase(), rows[j].name.toLowerCase());
      if (sim >= threshold) pairs.push({ a: rows[i], b: rows[j], similarity: Math.round(sim * 1000) / 1000 });
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  return pairs;
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
