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
  date: string;
  description: string;
  source_file_id?: string | null;
  source_page?: number | null;
  lines: JournalLineInput[];
}

export interface JournalEntryRow {
  id: string;
  date: string;
  description: string;
  source_file_id: string | null;
  source_page: number | null;
  created_at: string;
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

  const entryId = `je:${randomUUID()}`;
  const insertHeader = db.prepare(
    `INSERT INTO journal_entries (id, date, description, source_file_id, source_page)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertLine = db.prepare(
    `INSERT INTO journal_lines (id, entry_id, account_id, debit, credit, currency, memo, pii_flag)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction((): void => {
    insertHeader.run(
      entryId,
      entry.date,
      entry.description,
      entry.source_file_id ?? null,
      entry.source_page ?? null,
    );
    for (const line of entry.lines) {
      insertLine.run(
        `jl:${randomUUID()}`,
        entryId,
        line.account_id,
        line.debit ?? 0,
        line.credit ?? 0,
        line.currency || "THB",
        line.memo ?? null,
        line.pii_flag ? 1 : 0,
      );
    }
  });
  tx();

  return entryId;
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

  // Small chart of accounts → a single name lookup beats GROUP_CONCAT join
  // hacks (account names can contain commas which break a comma-separated
  // concat, and SQLite's GROUP_CONCAT has no robust escape mechanism).
  const nameById = new Map<string, string>();
  for (const row of db.prepare(`SELECT id, name FROM accounts`).all() as { id: string; name: string }[]) {
    nameById.set(row.id, row.name);
  }

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

function dayDiff(a: string, b: string): number {
  const aDate = Date.parse(a);
  const bDate = Date.parse(b);
  if (Number.isNaN(aDate) || Number.isNaN(bDate)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((bDate - aDate) / 86_400_000));
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
