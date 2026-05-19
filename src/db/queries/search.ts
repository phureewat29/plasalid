import type Database from "libsql";
import type { PostingRow } from "./transactions.js";

/**
 * Free-text search across transaction descriptions, posting memos, account
 * names, and merchant canonical names. Returns matching postings joined with
 * account + transaction + merchant metadata.
 */
export function searchPostings(db: Database.Database, query: string, limit = 30): PostingRow[] {
  const needle = `%${query}%`;
  const capped = Math.min(Math.max(limit, 1), 200);
  return db.prepare(
    `SELECT p.id, p.transaction_id, p.account_id, p.debit, p.credit, p.currency, p.memo,
            a.name AS account_name, a.type AS account_type,
            t.date AS transaction_date, t.description AS transaction_description,
            m.canonical_name AS merchant_name
     FROM postings p
     JOIN transactions t ON t.id = p.transaction_id
     JOIN accounts a ON a.id = p.account_id
     LEFT JOIN merchants m ON m.id = t.merchant_id
     WHERE t.description LIKE ?
        OR p.memo LIKE ?
        OR a.name LIKE ?
        OR m.canonical_name LIKE ?
     ORDER BY t.date DESC, t.id DESC
     LIMIT ?`,
  ).all(needle, needle, needle, needle, capped) as PostingRow[];
}
