import type Database from "libsql";
import type { AccountRow } from "./account-balance.js";

export interface FuzzyAccountMatch {
  account: AccountRow;
  similarity: number;
}

// Characters statements use to blank out the hidden middle of an account
// number (`470686XXXXXX9483`, `••7652`, `**1234`, `…9483`).
const MASK_CHARS = "Xx•*…";

/**
 * Everything after the LAST mask character in `s`, or `s` unchanged when it
 * contains none. Anchoring on the last mask char (rather than e.g. splitting
 * on all non-digits) means a masked run like `XXXXXX` isn't confused with the
 * separators (`-`, ` `) a plain check-digit suffix uses.
 */
function tailAfterMask(s: string): string {
  let lastAt = -1;
  for (const ch of MASK_CHARS) {
    const i = s.lastIndexOf(ch);
    if (i > lastAt) lastAt = i;
  }
  return lastAt === -1 ? s : s.slice(lastAt + 1);
}

/**
 * Canonical key for an account number, tolerant of a trailing check digit.
 * Statements sometimes print the same account with or without a trailing check
 * digit (`xxx-7652-0` vs `xxx-7652`); both should resolve to one account.
 * Masked numbers are first reduced to the tail after their last mask
 * character — this matters when real digits precede the mask
 * (`470686XXXXXX9483`), which would otherwise get concatenated with the
 * trailing digits and corrupt the check-digit heuristic below. From that
 * tail, keep digits only, drop the final digit when the run is long enough
 * to carry a separate check digit, and return the last 4.
 *
 *   "••7652"           -> "7652"
 *   "••7652-0"         -> "76520" -> "7652"
 *   "470686XXXXXX9483" -> "9483" (tail after the mask; no check digit to drop)
 *   "1234"             -> "1234"
 */
export function accountNumberKey(raw: string | null | undefined): string {
  const tail = tailAfterMask(String(raw ?? ""));
  const digits = tail.replace(/\D+/g, "");
  if (!digits) return "";
  const core = digits.length >= 5 ? digits.slice(0, -1) : digits;
  return core.slice(-4);
}

/**
 * Normalize a masked account number for storage so a trailing check digit
 * doesn't split one account into two: `••7652-0` and `••76520` both store as
 * `••7652`. Preserves the leading bullet mask; defaults to `••` when absent
 * (including when the input's own mask is a literal digit run with nothing
 * to preserve, e.g. `470686XXXXXX9483` -> `••9483`).
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

/**
 * Account-number key for a free-text query. When the text itself carries a
 * mask (a bank hint like `470686XXXXXX9483`), the tail after the mask is
 * authoritative — skip the "longest digit run" heuristic below, which would
 * otherwise pick the longer, unmasked prefix instead of the visible trailing
 * digits. Otherwise, fall back to the longest digit run in the text (e.g. a
 * plain check-digit-suffixed number typed alongside other words).
 */
function queryNumberKey(text: string): string {
  const tail = tailAfterMask(text);
  if (tail !== text) return accountNumberKey(tail);

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
