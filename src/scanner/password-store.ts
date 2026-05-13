import type Database from "libsql";
import { randomUUID } from "crypto";
import { basename } from "path";
import { encryptSecret, decryptSecret } from "../db/encryption.js";

export interface StoredPassword {
  id: string;
  pattern: string;
  password: string; // decrypted in-memory
  useCount: number;
  lastUsedAt: string | null;
}

interface Row {
  id: string;
  pattern: string;
  password_encrypted: string;
  use_count: number;
  last_used_at: string | null;
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
const SEPARATORS = /[_\-\s.]/;
const MIN_PREFIX_LEN = 3;

/**
 * Derive a regex from a filename. Strategy: take the leading alphabetic-ish
 * prefix (up to the first separator: underscore, hyphen, space, or dot) and
 * wildcard everything after it. Looser than a literal match — `AcctSt_May26.pdf`
 * and `AcctSt_Jun26.pdf` share the same pattern.
 *
 * Falls back to the older digit-collapse strategy when the prefix is too short
 * (<3 chars) or doesn't start with a letter, so we don't end up with overly
 * generic patterns like `^a.*` or `^\d+.*`.
 *
 * Examples:
 *   `AcctSt_May26.pdf`          → `^acctst.*`
 *   `KBank-Savings-2026-01.pdf` → `^kbank.*`
 *   `statement.pdf`             → `^statement.*`
 *   `1234567890.pdf`            → `^\d+\.pdf$`           (fallback)
 *   `e-statement.pdf`           → `^e\-statement\.pdf$`  (fallback — prefix too short)
 */
export function suggestPattern(filename: string): string {
  const name = basename(filename).toLowerCase();
  const prefix = name.split(SEPARATORS)[0];

  if (prefix.length >= MIN_PREFIX_LEN && /^[a-z]/.test(prefix)) {
    return `^${prefix.replace(REGEX_META, "\\$&")}.*`;
  }

  const escaped = name.replace(REGEX_META, "\\$&");
  const collapsed = escaped.replace(/\d+/g, "\\d+");
  return `^${collapsed}$`;
}

/** Stored passwords whose pattern matches the basename of `filePath`. */
export function findCandidates(
  db: Database.Database,
  filePath: string,
  dbKey: string,
): StoredPassword[] {
  const target = basename(filePath);
  const rows = db
    .prepare(
      `SELECT id, pattern, password_encrypted, use_count, last_used_at
       FROM file_passwords
       ORDER BY use_count DESC, last_used_at DESC NULLS LAST, created_at ASC`,
    )
    .all() as Row[];
  return rows
    .filter(r => safeTest(r.pattern, target))
    .map(r => ({
      id: r.id,
      pattern: r.pattern,
      password: decryptSecret(r.password_encrypted, dbKey),
      useCount: r.use_count,
      lastUsedAt: r.last_used_at,
    }));
}

function safeTest(pattern: string, target: string): boolean {
  try {
    return new RegExp(pattern, "i").test(target);
  } catch {
    return false;
  }
}

/**
 * Upsert by pattern. If the pattern already exists the row is replaced — useful
 * when the bank rotates the password for a recurring statement series.
 */
export function savePassword(
  db: Database.Database,
  pattern: string,
  password: string,
  dbKey: string,
): string {
  const encrypted = encryptSecret(password, dbKey);
  const existing = db
    .prepare(`SELECT id FROM file_passwords WHERE pattern = ?`)
    .get(pattern) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE file_passwords
       SET password_encrypted = ?, use_count = 0, last_used_at = NULL
       WHERE id = ?`,
    ).run(encrypted, existing.id);
    return existing.id;
  }
  const id = `fp:${randomUUID()}`;
  db.prepare(
    `INSERT INTO file_passwords (id, pattern, password_encrypted) VALUES (?, ?, ?)`,
  ).run(id, pattern, encrypted);
  return id;
}

export function recordUse(db: Database.Database, id: string): void {
  db.prepare(
    `UPDATE file_passwords
     SET use_count = use_count + 1, last_used_at = datetime('now')
     WHERE id = ?`,
  ).run(id);
}
