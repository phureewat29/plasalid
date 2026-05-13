import type Database from "libsql";
import type { JournalLineRow } from "./journal.js";

/**
 * Free-text search across journal entry descriptions, line memos, and account
 * names. Returns matching journal lines joined with account + entry metadata.
 */
export function searchJournalLines(db: Database.Database, query: string, limit = 30): JournalLineRow[] {
  const needle = `%${query}%`;
  const capped = Math.min(Math.max(limit, 1), 200);
  return db.prepare(
    `SELECT jl.id, jl.entry_id, jl.account_id, jl.debit, jl.credit, jl.currency, jl.memo,
            a.name AS account_name, a.type AS account_type,
            je.date AS entry_date, je.description AS entry_description
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.entry_id
     JOIN accounts a ON a.id = jl.account_id
     WHERE je.description LIKE ?
        OR jl.memo LIKE ?
        OR a.name LIKE ?
     ORDER BY je.date DESC, je.id DESC
     LIMIT ?`,
  ).all(needle, needle, needle, capped) as JournalLineRow[];
}
