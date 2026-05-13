import type Database from "libsql";

export type AccountType = "asset" | "liability" | "income" | "expense" | "equity";

export interface AccountRow {
  id: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  bank_name: string | null;
  account_number_masked: string | null;
  currency: string;
  due_day: number | null;
  statement_day: number | null;
  points_balance: number | null;
  metadata_json: string | null;
  pii_flag: number;
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
            COALESCE(SUM(jl.debit), 0)  AS sum_debit,
            COALESCE(SUM(jl.credit), 0) AS sum_credit
     FROM accounts a
     LEFT JOIN journal_lines jl ON jl.account_id = a.id
     ${whereSql}
     GROUP BY a.id
     ORDER BY a.type, a.name`,
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
        COALESCE(SUM(CASE WHEN a.type = 'income'  THEN jl.credit - jl.debit ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN a.type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS expenses
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.entry_id
     JOIN accounts a ON a.id = jl.account_id
     WHERE je.date BETWEEN ? AND ?`,
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
 * Re-point every journal line on `fromId` to `toId`, then delete the source
 * account. Wrapped in a transaction. Returns the number of journal lines moved.
 * Throws if either account doesn't exist.
 */
export function mergeAccounts(db: Database.Database, fromId: string, toId: string): number {
  if (fromId === toId) throw new Error("Cannot merge an account into itself.");
  const from = findAccountById(db, fromId);
  if (!from) throw new Error(`Source account ${fromId} not found.`);
  const to = findAccountById(db, toId);
  if (!to) throw new Error(`Destination account ${toId} not found.`);

  let moved = 0;
  const tx = db.transaction((): void => {
    moved = db
      .prepare(`UPDATE journal_lines SET account_id = ? WHERE account_id = ?`)
      .run(toId, fromId).changes;
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(fromId);
  });
  tx();
  return moved;
}

/** Delete an account only if no journal_lines reference it. */
export function deleteAccount(db: Database.Database, id: string): void {
  const inUse = db
    .prepare(`SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1`)
    .get(id);
  if (inUse) {
    throw new Error(`Account ${id} still has journal lines; merge it first.`);
  }
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
}

export interface SimilarAccountPair {
  a: AccountRow;
  b: AccountRow;
  similarity: number;
}

/**
 * Pairwise Levenshtein similarity over `accounts.name`. Returns pairs above the
 * threshold (0–1, where 1 = identical), sorted highest first. Quadratic in the
 * number of accounts — fine for the small N a personal chart of accounts holds.
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

export function findUnusedAccounts(db: Database.Database): AccountRow[] {
  return db
    .prepare(
      `SELECT a.* FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
       WHERE jl.id IS NULL
       ORDER BY a.name`,
    )
    .all() as AccountRow[];
}

// ── helpers ────────────────────────────────────────────────────────────────

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
