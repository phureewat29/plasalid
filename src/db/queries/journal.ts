import type Database from "libsql";
import { randomUUID } from "crypto";

const TOLERANCE = 0.005;

export interface JournalLineInput {
  account_id: string;
  debit?: number;
  credit?: number;
  currency?: string;
  memo?: string | null;
  pii_flag?: boolean;
}

export interface JournalEntryInput {
  /** Optional pre-assigned id. Used by the buffered-write path so concerns recorded mid-scan can reference the entry before commit. */
  id?: string;
  date: string;
  description: string;
  source_file_id?: string | null;
  source_page?: number | null;
  lines: JournalLineInput[];
}

export interface JournalLineRow {
  id: string;
  entry_id: string;
  account_id: string;
  debit: number;
  credit: number;
  currency: string;
  memo: string | null;
  account_name?: string;
  account_type?: string;
  entry_date?: string;
  entry_description?: string;
}

/**
 * Insert a balanced journal entry. Throws if SUM(debit) !== SUM(credit) or any
 * line both debits and credits. Transaction-wrapped: lines never land without
 * a header, header never lands without lines.
 */
export function recordJournalEntry(db: Database.Database, entry: JournalEntryInput): string {
  const validated = validateJournalEntry(entry);
  const tx = db.transaction((): void => { insertJournalEntryRows(db, validated); });
  tx();
  return validated.id;
}

/**
 * Validate balance + invariants and assign an id. Pure (no DB writes). Used by
 * both `recordJournalEntry` and the buffered-scan commit path; the latter
 * already runs inside its own transaction and must not open another.
 */
export function validateJournalEntry(entry: JournalEntryInput): JournalEntryInput & { id: string } {
  if (!entry.lines || entry.lines.length < 2) {
    throw new Error("Journal entry must contain at least two lines.");
  }

  let debitTotal = 0;
  let creditTotal = 0;
  for (const line of entry.lines) {
    const debit = line.debit ?? 0;
    const credit = line.credit ?? 0;
    if (debit < 0 || credit < 0) {
      throw new Error("debit and credit values must be non-negative.");
    }
    if (debit > 0 && credit > 0) {
      throw new Error("A single journal line cannot debit and credit at the same time.");
    }
    if (debit === 0 && credit === 0) {
      throw new Error("Each journal line must have either a debit or a credit.");
    }
    debitTotal += debit;
    creditTotal += credit;
  }

  if (Math.abs(debitTotal - creditTotal) > TOLERANCE) {
    throw new Error(
      `Journal entry does not balance: debits ${debitTotal.toFixed(2)} vs credits ${creditTotal.toFixed(2)}.`,
    );
  }

  return { ...entry, id: entry.id ?? `je:${randomUUID()}` };
}

/**
 * Insert-only counterpart to `recordJournalEntry`. The caller is responsible
 * for opening a transaction (or for accepting partial writes). Expects an
 * already-validated entry from `validateJournalEntry`.
 */
export function insertJournalEntryRows(
  db: Database.Database,
  entry: JournalEntryInput & { id: string },
): void {
  db.prepare(
    `INSERT INTO journal_entries (id, date, description, source_file_id, source_page)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.date,
    entry.description,
    entry.source_file_id ?? null,
    entry.source_page ?? null,
  );
  const insertLine = db.prepare(
    `INSERT INTO journal_lines (id, entry_id, account_id, debit, credit, currency, memo, pii_flag)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const line of entry.lines) {
    insertLine.run(
      `jl:${randomUUID()}`,
      entry.id,
      line.account_id,
      line.debit ?? 0,
      line.credit ?? 0,
      line.currency || "THB",
      line.memo ?? null,
      line.pii_flag ? 1 : 0,
    );
  }
}

export interface ListJournalLinesOptions {
  account_id?: string;
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
}

export interface UpdateJournalEntryFields {
  date?: string;
  description?: string;
  source_page?: number | null;
}

export function updateJournalEntry(
  db: Database.Database,
  entryId: string,
  fields: UpdateJournalEntryFields,
): number {
  const sets: string[] = [];
  const params: any[] = [];
  if (fields.date !== undefined)        { sets.push("date = ?");        params.push(fields.date); }
  if (fields.description !== undefined) { sets.push("description = ?"); params.push(fields.description); }
  if (fields.source_page !== undefined) { sets.push("source_page = ?"); params.push(fields.source_page); }
  if (sets.length === 0) return 0;
  params.push(entryId);
  return db.prepare(`UPDATE journal_entries SET ${sets.join(", ")} WHERE id = ?`).run(...params).changes;
}

export interface UpdateJournalLineFields {
  account_id?: string;
  memo?: string | null;
}

/**
 * Safe single-line edits only. Refuses changes to `debit`, `credit`, or `currency`
 * because those would silently break the entry's balance — to fix amounts the
 * caller must delete the entry and record a fresh one.
 */
export function updateJournalLine(
  db: Database.Database,
  lineId: string,
  fields: UpdateJournalLineFields,
): number {
  const sets: string[] = [];
  const params: any[] = [];
  if (fields.account_id !== undefined) { sets.push("account_id = ?"); params.push(fields.account_id); }
  if (fields.memo !== undefined)       { sets.push("memo = ?");       params.push(fields.memo); }
  if (sets.length === 0) return 0;
  params.push(lineId);
  return db.prepare(`UPDATE journal_lines SET ${sets.join(", ")} WHERE id = ?`).run(...params).changes;
}

/**
 * Delete a journal entry. ON DELETE CASCADE on `journal_lines.entry_id` removes
 * the lines automatically.
 */
export function deleteJournalEntry(db: Database.Database, entryId: string): number {
  return db.prepare(`DELETE FROM journal_entries WHERE id = ?`).run(entryId).changes;
}

export interface DuplicateGroupEntry {
  id: string;
  date: string;
  description: string;
  amount: number;
  account_ids: string[];
  account_names: string[];
}

export interface FindDuplicateEntriesOptions {
  /** Days of slack when grouping by date. 0 means same-day only. Default 2. */
  toleranceDays?: number;
  /** Only consider entries that have at least one line on this account. */
  accountId?: string;
  /** Skip entries whose total debit is below this value. */
  minAmount?: number;
}

/**
 * Heuristic duplicate finder: group entries by (rounded total debit) and check
 * pairs whose date difference is ≤ toleranceDays. Returns groups with ≥2 members.
 * Each entry carries both account_ids (for follow-up tool calls) and
 * account_names (for human-readable presentation to the user).
 */
export function findDuplicateEntries(
  db: Database.Database,
  opts: FindDuplicateEntriesOptions = {},
): DuplicateGroupEntry[][] {
  const toleranceDays = Math.max(0, Math.floor(opts.toleranceDays ?? 2));
  const minAmount = opts.minAmount ?? 0;

  const accountFilter = opts.accountId
    ? `WHERE je.id IN (SELECT entry_id FROM journal_lines WHERE account_id = ?)`
    : ``;
  const params: any[] = opts.accountId ? [opts.accountId] : [];

  const nameById = loadAccountNames(db);

  const rows = db.prepare(
    `SELECT je.id, je.date, je.description,
            COALESCE(SUM(jl.debit), 0) AS amount,
            GROUP_CONCAT(jl.account_id) AS account_ids
     FROM journal_entries je
     LEFT JOIN journal_lines jl ON jl.entry_id = je.id
     ${accountFilter}
     GROUP BY je.id`,
  ).all(...params) as {
    id: string;
    date: string;
    description: string;
    amount: number;
    account_ids: string | null;
  }[];

  const entries: DuplicateGroupEntry[] = rows
    .filter(r => r.amount >= minAmount)
    .map(r => {
      const ids = (r.account_ids ?? "").split(",").filter(Boolean);
      return {
        id: r.id,
        date: r.date,
        description: r.description,
        amount: Math.round(r.amount * 100) / 100,
        account_ids: ids,
        account_names: ids.map(id => nameById.get(id) ?? id),
      };
    });

  const byAmount = new Map<number, DuplicateGroupEntry[]>();
  for (const e of entries) {
    const key = Math.round(e.amount * 100); // cents
    const arr = byAmount.get(key) ?? [];
    arr.push(e);
    byAmount.set(key, arr);
  }

  const groups: DuplicateGroupEntry[][] = [];
  for (const candidates of byAmount.values()) {
    if (candidates.length < 2) continue;
    candidates.sort((a, b) => a.date.localeCompare(b.date));
    let current: DuplicateGroupEntry[] = [];
    for (const e of candidates) {
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

// ── Correlations ────────────────────────────────────────────────────────────

export interface CorrelatedEntryPair {
  amount: number;
  currency: string;
  day_gap: number;
  a: { id: string; date: string; description: string; account_ids: string[]; account_names: string[] };
  b: { id: string; date: string; description: string; account_ids: string[]; account_names: string[] };
}

export interface FindCorrelatedEntriesOptions {
  from?: string;
  to?: string;
  /** Max day difference between paired entries. Default 3. */
  toleranceDays?: number;
  /** Skip entries below this total debit. Default 0. */
  minAmount?: number;
}

/**
 * Heuristic: surface pairs of entries that look like the same money movement
 * recorded against different accounts (e.g. a bank-to-card transfer that lands
 * once on the bank statement and again on the card statement). Filters out
 * pairs whose account-id sets overlap (those are duplicates, not correlations).
 */
export function findCorrelatedEntries(
  db: Database.Database,
  opts: FindCorrelatedEntriesOptions = {},
): CorrelatedEntryPair[] {
  const toleranceDays = Math.max(0, Math.floor(opts.toleranceDays ?? 3));
  const minAmount = opts.minAmount ?? 0;

  const dateFilter: string[] = [];
  const params: any[] = [];
  if (opts.from) { dateFilter.push("je.date >= ?"); params.push(opts.from); }
  if (opts.to)   { dateFilter.push("je.date <= ?"); params.push(opts.to); }
  const where = dateFilter.length ? `WHERE ${dateFilter.join(" AND ")}` : "";

  const nameById = loadAccountNames(db);

  const rows = db.prepare(
    `SELECT je.id, je.date, je.description,
            COALESCE(SUM(jl.debit), 0) AS amount,
            COALESCE(MAX(jl.currency), 'THB') AS currency,
            GROUP_CONCAT(jl.account_id) AS account_ids
     FROM journal_entries je
     LEFT JOIN journal_lines jl ON jl.entry_id = je.id
     ${where}
     GROUP BY je.id`,
  ).all(...params) as {
    id: string;
    date: string;
    description: string;
    amount: number;
    currency: string;
    account_ids: string | null;
  }[];

  const entries: CorrelationCandidate[] = rows
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

  return correlatePairs(entries, { toleranceDays });
}

export interface CorrelationCandidate {
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
 *
 * Used by the DB-backed `findCorrelatedEntries` and by the scan-time
 * coordinator that runs over buffered, not-yet-committed entries.
 */
export function correlatePairs(
  entries: CorrelationCandidate[],
  opts: { toleranceDays?: number } = {},
): CorrelatedEntryPair[] {
  const toleranceDays = Math.max(0, Math.floor(opts.toleranceDays ?? 3));

  // Bucket by (amount-cents, currency) so we only compare entries that could
  // plausibly pair. O(n) bucketing + O(k²) per bucket dominates only when many
  // entries share the same amount.
  const buckets = new Map<string, CorrelationCandidate[]>();
  for (const e of entries) {
    const key = `${Math.round(e.amount * 100)}|${e.currency}`;
    const arr = buckets.get(key) ?? [];
    arr.push(e);
    buckets.set(key, arr);
  }

  const pairs: CorrelatedEntryPair[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((x, y) => x.date.localeCompare(y.date));
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i], b = bucket[j];
        const gap = dayDiff(a.date, b.date);
        if (gap > toleranceDays) break; // bucket is sorted by date
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

export function listJournalLines(db: Database.Database, opts: ListJournalLinesOptions = {}): JournalLineRow[] {
  const conditions: string[] = [];
  const params: any[] = [];

  if (opts.account_id) {
    conditions.push("jl.account_id = ?");
    params.push(opts.account_id);
  }
  if (opts.from) {
    conditions.push("je.date >= ?");
    params.push(opts.from);
  }
  if (opts.to) {
    conditions.push("je.date <= ?");
    params.push(opts.to);
  }
  if (opts.q) {
    conditions.push("(je.description LIKE ? OR jl.memo LIKE ?)");
    params.push(`%${opts.q}%`, `%${opts.q}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);

  return db.prepare(
    `SELECT jl.id, jl.entry_id, jl.account_id, jl.debit, jl.credit, jl.currency, jl.memo,
            a.name AS account_name, a.type AS account_type,
            je.date AS entry_date, je.description AS entry_description
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.entry_id
     JOIN accounts a ON a.id = jl.account_id
     ${where}
     ORDER BY je.date DESC, je.id DESC
     LIMIT ?`,
  ).all(...params, limit) as JournalLineRow[];
}
