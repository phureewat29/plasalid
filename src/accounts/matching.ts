import type Database from "libsql";
import type { AccountRow } from "./types.js";

export interface FuzzyAccountMatch {
  account: AccountRow;
  similarity: number;
}

// Characters statements use to blank out the hidden middle of an account
// number (`470686XXXXXX9483`, `••7652`, `**1234`, `…9483`).
const MASK_CHARS = "Xx•*…";

/** Everything after the last mask char in `s` (or `s` unchanged if none), so a
 *  masked run like `XXXXXX` isn't confused with a check-digit separator. */
function tailAfterMask(s: string): string {
  let lastAt = -1;
  for (const ch of MASK_CHARS) {
    const i = s.lastIndexOf(ch);
    if (i > lastAt) lastAt = i;
  }
  return lastAt === -1 ? s : s.slice(lastAt + 1);
}

/**
 * Canonical key for an account number, tolerant of a trailing check digit
 * (`xxx-7652-0` and `xxx-7652` both resolve to one account). Masked digits
 * before the mask are stripped first via `tailAfterMask` so they can't
 * corrupt the check-digit heuristic.
 *
 *   "••7652"           -> "7652"
 *   "••7652-0"         -> "76520" -> "7652"
 *   "470686XXXXXX9483" -> "9483"
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
 * Normalizes for storage so a trailing check digit can't split one account
 * into two (`••7652-0` and `••76520` both store as `••7652`). Preserves the
 * leading mask prefix, defaulting to `••` when there isn't one to preserve.
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
 * Account-number key for a free-text query. A mask in the text (e.g.
 * `470686XXXXXX9483`) is authoritative — the tail after it wins over the
 * "longest digit run" fallback, which would otherwise prefer the longer
 * unmasked prefix over the visible trailing digits.
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
 * Ranks accounts by name similarity, matches >= `threshold` first. Bonus
 * weight when the query is a substring of the name (so "ttb saving" finds
 * "TTB Savings ••1234" despite mediocre full-string Levenshtein). A query
 * carrying an account number also matches check-digit-tolerantly against the
 * row's masked number — callers confirm before acting, so a rare same-last-4
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
