import type Database from "libsql";
import { randomUUID } from "crypto";
import { upsertMerchant, type MerchantUpsertInput } from "./merchants.js";

const TOLERANCE = 0.005;

export interface PostingInput {
  account_id: string;
  debit?: number;
  credit?: number;
  currency?: string;
  memo?: string | null;
  pii_flag?: boolean;
}

export interface TransactionInput {
  /** Optional pre-assigned id. Used by the buffered-write path so unknowns recorded mid-scan can reference the transaction before commit. */
  id?: string;
  date: string;
  description: string;
  source_file_id?: string | null;
  source_page?: number | null;
  raw_descriptor?: string | null;
  merchant?: MerchantUpsertInput | null;
  /** Pre-resolved merchant id (from scanner's alias pre-resolution pass). Overrides any `merchant` upsert when set. */
  merchant_id?: string | null;
  postings: PostingInput[];
}

export interface PostingRow {
  id: string;
  transaction_id: string;
  account_id: string;
  debit: number;
  credit: number;
  currency: string;
  memo: string | null;
  account_name?: string;
  account_type?: string;
  transaction_date?: string;
  transaction_description?: string;
  merchant_name?: string | null;
}

/**
 * Insert a balanced transaction. Throws if SUM(debit) !== SUM(credit) or any
 * posting both debits and credits. Transaction-wrapped: postings never land
 * without a header, header never lands without postings.
 */
export function recordTransaction(db: Database.Database, input: TransactionInput): string {
  const validated = validateTransaction(input);
  const tx = db.transaction((): void => { insertTransactionRows(db, validated); });
  tx();
  return validated.id;
}

/**
 * Validate balance + invariants and assign an id. Pure (no DB writes). Used by
 * both `recordTransaction` and the buffered-scan commit path; the latter
 * already runs inside its own transaction and must not open another.
 */
export function validateTransaction(input: TransactionInput): TransactionInput & { id: string } {
  if (!input.postings || input.postings.length < 2) {
    throw new Error("Transaction must contain at least two postings.");
  }

  let debitTotal = 0;
  let creditTotal = 0;
  for (const p of input.postings) {
    const debit = p.debit ?? 0;
    const credit = p.credit ?? 0;
    if (debit < 0 || credit < 0) {
      throw new Error("debit and credit values must be non-negative.");
    }
    if (debit > 0 && credit > 0) {
      throw new Error("A single posting cannot debit and credit at the same time.");
    }
    if (debit === 0 && credit === 0) {
      throw new Error("Each posting must have either a debit or a credit.");
    }
    debitTotal += debit;
    creditTotal += credit;
  }

  if (Math.abs(debitTotal - creditTotal) > TOLERANCE) {
    throw new Error(
      `Transaction does not balance: debits ${debitTotal.toFixed(2)} vs credits ${creditTotal.toFixed(2)}.`,
    );
  }

  return { ...input, id: input.id ?? `tx:${randomUUID()}` };
}

/**
 * Insert-only counterpart to `recordTransaction`. The caller is responsible
 * for opening a transaction (or for accepting partial writes). Expects an
 * already-validated input from `validateTransaction`.
 */
export function insertTransactionRows(
  db: Database.Database,
  input: TransactionInput & { id: string },
): void {
  let merchantId = input.merchant_id ?? null;
  if (!merchantId && input.merchant) {
    merchantId = upsertMerchant(db, input.merchant).id;
  }
  db.prepare(
    `INSERT INTO transactions (id, date, description, merchant_id, raw_descriptor, source_file_id, source_page)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.date,
    input.description,
    merchantId,
    input.raw_descriptor ?? null,
    input.source_file_id ?? null,
    input.source_page ?? null,
  );
  const insertPosting = db.prepare(
    `INSERT INTO postings (id, transaction_id, account_id, debit, credit, currency, memo, pii_flag)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of input.postings) {
    insertPosting.run(
      `p:${randomUUID()}`,
      input.id,
      p.account_id,
      p.debit ?? 0,
      p.credit ?? 0,
      p.currency || "THB",
      p.memo ?? null,
      p.pii_flag ? 1 : 0,
    );
  }
}

export interface ListPostingsOptions {
  account_id?: string;
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
}

export interface UpdateTransactionFields {
  date?: string;
  description?: string;
  source_page?: number | null;
}

export function updateTransaction(
  db: Database.Database,
  transactionId: string,
  fields: UpdateTransactionFields,
): number {
  const sets: string[] = [];
  const params: any[] = [];
  if (fields.date !== undefined)        { sets.push("date = ?");        params.push(fields.date); }
  if (fields.description !== undefined) { sets.push("description = ?"); params.push(fields.description); }
  if (fields.source_page !== undefined) { sets.push("source_page = ?"); params.push(fields.source_page); }
  if (sets.length === 0) return 0;
  params.push(transactionId);
  return db.prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`).run(...params).changes;
}

export interface UpdatePostingFields {
  account_id?: string;
  memo?: string | null;
}

/**
 * Safe single-posting edits only. Refuses changes to `debit`, `credit`, or `currency`
 * because those would silently break the transaction's balance — to fix amounts the
 * caller must delete the transaction and record a fresh one.
 */
export function updatePosting(
  db: Database.Database,
  postingId: string,
  fields: UpdatePostingFields,
): number {
  const sets: string[] = [];
  const params: any[] = [];
  if (fields.account_id !== undefined) { sets.push("account_id = ?"); params.push(fields.account_id); }
  if (fields.memo !== undefined)       { sets.push("memo = ?");       params.push(fields.memo); }
  if (sets.length === 0) return 0;
  params.push(postingId);
  return db.prepare(`UPDATE postings SET ${sets.join(", ")} WHERE id = ?`).run(...params).changes;
}

/**
 * Delete a transaction. ON DELETE CASCADE on `postings.transaction_id` removes
 * the postings automatically.
 */
export function deleteTransaction(db: Database.Database, transactionId: string): number {
  return db.prepare(`DELETE FROM transactions WHERE id = ?`).run(transactionId).changes;
}

export interface DuplicateGroupTransaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  source_file_id: string | null;
  merchant_id: string | null;
  account_ids: string[];
  account_names: string[];
}

export interface FindDuplicateTransactionsOptions {
  /** Days of slack when grouping by date. 0 means same-day only. Default 2. */
  toleranceDays?: number;
  /** Only consider transactions that have at least one posting on this account. */
  accountId?: string;
  /** Skip transactions whose total debit is below this value. */
  minAmount?: number;
}

/**
 * Heuristic duplicate finder: group transactions by (rounded total debit) and check
 * pairs whose date difference is ≤ toleranceDays. Returns groups with ≥2 members.
 * Each transaction carries both account_ids (for follow-up tool calls) and
 * account_names (for human-readable presentation to the user).
 */
export function findDuplicateTransactions(
  db: Database.Database,
  opts: FindDuplicateTransactionsOptions = {},
): DuplicateGroupTransaction[][] {
  const toleranceDays = Math.max(0, Math.floor(opts.toleranceDays ?? 2));
  const minAmount = opts.minAmount ?? 0;

  const accountFilter = opts.accountId
    ? `WHERE t.id IN (SELECT transaction_id FROM postings WHERE account_id = ?)`
    : ``;
  const params: any[] = opts.accountId ? [opts.accountId] : [];

  const nameById = loadAccountNames(db);

  const rows = db.prepare(
    `SELECT t.id, t.date, t.description, t.source_file_id, t.merchant_id,
            COALESCE(SUM(p.debit), 0) AS amount,
            GROUP_CONCAT(p.account_id) AS account_ids
     FROM transactions t
     LEFT JOIN postings p ON p.transaction_id = t.id
     ${accountFilter}
     GROUP BY t.id`,
  ).all(...params) as {
    id: string;
    date: string;
    description: string;
    source_file_id: string | null;
    merchant_id: string | null;
    amount: number;
    account_ids: string | null;
  }[];

  const candidates: DuplicateGroupTransaction[] = rows
    .filter(r => r.amount >= minAmount)
    .map(r => {
      const ids = (r.account_ids ?? "").split(",").filter(Boolean);
      return {
        id: r.id,
        date: r.date,
        description: r.description,
        amount: Math.round(r.amount * 100) / 100,
        source_file_id: r.source_file_id,
        merchant_id: r.merchant_id,
        account_ids: ids,
        account_names: ids.map(id => nameById.get(id) ?? id),
      };
    });

  const byAmount = new Map<number, DuplicateGroupTransaction[]>();
  for (const e of candidates) {
    const key = Math.round(e.amount * 100);
    const arr = byAmount.get(key) ?? [];
    arr.push(e);
    byAmount.set(key, arr);
  }

  const groups: DuplicateGroupTransaction[][] = [];
  for (const arr of byAmount.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => a.date.localeCompare(b.date));
    let current: DuplicateGroupTransaction[] = [];
    for (const e of arr) {
      if (current.length === 0) {
        current.push(e);
        continue;
      }
      const last = current[current.length - 1];
      if (dayDiff(last.date, e.date) <= toleranceDays) {
        current.push(e);
      } else {
        if (current.length >= 2) groups.push(current);
        current = [e];
      }
    }
    if (current.length >= 2) groups.push(current);
  }
  return groups;
}

export function dayDiff(a: string, b: string): number {
  const aDate = Date.parse(a);
  const bDate = Date.parse(b);
  if (Number.isNaN(aDate) || Number.isNaN(bDate)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((bDate - aDate) / 86_400_000));
}

/**
 * Load all account id → name pairs into an in-memory map. Cheap on the small
 * charts of accounts Plasalid deals with, and avoids GROUP_CONCAT join hacks
 * (account names can contain commas which break a comma-separated concat, and
 * SQLite's GROUP_CONCAT has no robust escape mechanism).
 */
function loadAccountNames(db: Database.Database): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of db.prepare(`SELECT id, name FROM accounts`).all() as { id: string; name: string }[]) {
    map.set(row.id, row.name);
  }
  return map;
}

export interface CorrelatedTransactionPair {
  amount: number;
  currency: string;
  day_gap: number;
  a: { id: string; date: string; description: string; account_ids: string[]; account_names: string[] };
  b: { id: string; date: string; description: string; account_ids: string[]; account_names: string[] };
}

export interface FindCorrelatedTransactionsOptions {
  from?: string;
  to?: string;
  /** Max day difference between paired transactions. Default 3. */
  toleranceDays?: number;
  /** Skip transactions below this total debit. Default 0. */
  minAmount?: number;
}

/**
 * Heuristic: surface pairs of transactions that look like the same money movement
 * recorded against different accounts (e.g. a bank-to-card transfer that lands
 * once on the bank statement and again on the card statement). Filters out
 * pairs whose account-id sets overlap (those are duplicates, not correlations).
 */
export function findCorrelatedTransactions(
  db: Database.Database,
  opts: FindCorrelatedTransactionsOptions = {},
): CorrelatedTransactionPair[] {
  const toleranceDays = Math.max(0, Math.floor(opts.toleranceDays ?? 3));
  const minAmount = opts.minAmount ?? 0;

  const dateFilter: string[] = [];
  const params: any[] = [];
  if (opts.from) { dateFilter.push("t.date >= ?"); params.push(opts.from); }
  if (opts.to)   { dateFilter.push("t.date <= ?"); params.push(opts.to); }
  const where = dateFilter.length ? `WHERE ${dateFilter.join(" AND ")}` : "";

  const nameById = loadAccountNames(db);

  const rows = db.prepare(
    `SELECT t.id, t.date, t.description,
            COALESCE(SUM(p.debit), 0) AS amount,
            COALESCE(MAX(p.currency), 'THB') AS currency,
            GROUP_CONCAT(p.account_id) AS account_ids
     FROM transactions t
     LEFT JOIN postings p ON p.transaction_id = t.id
     ${where}
     GROUP BY t.id`,
  ).all(...params) as {
    id: string;
    date: string;
    description: string;
    amount: number;
    currency: string;
    account_ids: string | null;
  }[];

  const candidates: CorrelationCandidate[] = rows
    .filter(r => r.amount >= minAmount)
    .map(r => {
      const ids = (r.account_ids ?? "").split(",").filter(Boolean);
      return {
        id: r.id,
        date: r.date,
        description: r.description,
        amount: Math.round(r.amount * 100) / 100,
        currency: r.currency || "THB",
        account_ids: ids,
        account_names: ids.map(id => nameById.get(id) ?? id),
      };
    });

  return correlatePairs(candidates, { toleranceDays });
}

interface CorrelationCandidate {
  id: string;
  date: string;
  description: string;
  amount: number;
  currency: string;
  account_ids: string[];
  account_names: string[];
}

/**
 * Pure pair-finder: given an array of candidates already filtered by amount
 * and equipped with account_ids/names, return the cross-pairs that look like
 * the same money movement on different accounts (date within toleranceDays,
 * same amount + currency, non-overlapping account sets).
 */
function correlatePairs(
  candidates: CorrelationCandidate[],
  opts: { toleranceDays?: number } = {},
): CorrelatedTransactionPair[] {
  const toleranceDays = Math.max(0, Math.floor(opts.toleranceDays ?? 3));

  const buckets = new Map<string, CorrelationCandidate[]>();
  for (const e of candidates) {
    const key = `${Math.round(e.amount * 100)}|${e.currency}`;
    const arr = buckets.get(key) ?? [];
    arr.push(e);
    buckets.set(key, arr);
  }

  const pairs: CorrelatedTransactionPair[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((x, y) => x.date.localeCompare(y.date));
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i], b = bucket[j];
        const gap = dayDiff(a.date, b.date);
        if (gap > toleranceDays) break;
        const overlap = a.account_ids.some(id => b.account_ids.includes(id));
        if (overlap) continue;
        pairs.push({
          amount: a.amount,
          currency: a.currency,
          day_gap: gap,
          a: { id: a.id, date: a.date, description: a.description, account_ids: a.account_ids, account_names: a.account_names },
          b: { id: b.id, date: b.date, description: b.description, account_ids: b.account_ids, account_names: b.account_names },
        });
      }
    }
  }
  return pairs;
}

export function listPostings(db: Database.Database, opts: ListPostingsOptions = {}): PostingRow[] {
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.account_id) {
    conditions.push("p.account_id = ?");
    params.push(opts.account_id);
  }
  if (opts.from) {
    conditions.push("t.date >= ?");
    params.push(opts.from);
  }
  if (opts.to) {
    conditions.push("t.date <= ?");
    params.push(opts.to);
  }
  if (opts.q) {
    conditions.push("(t.description LIKE ? OR p.memo LIKE ? OR m.canonical_name LIKE ?)");
    params.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);

  return db.prepare(
    `SELECT p.id, p.transaction_id, p.account_id, p.debit, p.credit, p.currency, p.memo,
            a.name AS account_name, a.type AS account_type,
            t.date AS transaction_date, t.description AS transaction_description,
            m.canonical_name AS merchant_name
     FROM postings p
     JOIN transactions t ON t.id = p.transaction_id
     JOIN accounts a ON a.id = p.account_id
     LEFT JOIN merchants m ON m.id = t.merchant_id
     ${where}
     ORDER BY t.date DESC, t.id DESC
     LIMIT ?`,
  ).all(...params, limit) as PostingRow[];
}
