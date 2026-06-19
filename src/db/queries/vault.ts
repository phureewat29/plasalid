import type Database from "libsql";

export interface VaultPasswordRow {
  id: string;
  pattern: string;
  use_count: number;
  last_used_at: string | null;
}

/**
 * List stored file passwords for display. Never selects `password_encrypted`
 * — this is a vault browser, not a decrypt path (see `scanner/pdf.ts`'s
 * `findCandidates` for the decrypting reader used at scan time).
 */
export function listPasswords(db: Database.Database): VaultPasswordRow[] {
  return db
    .prepare(
      `SELECT id, pattern, use_count, last_used_at
       FROM file_passwords
       ORDER BY use_count DESC, last_used_at DESC NULLS LAST, created_at ASC`,
    )
    .all() as VaultPasswordRow[];
}

/**
 * Delete a stored password by id or by exact pattern match. Returns whether a
 * row was deleted.
 */
export function deletePassword(db: Database.Database, patternOrId: string): boolean {
  const result = db
    .prepare(`DELETE FROM file_passwords WHERE id = ? OR pattern = ?`)
    .run(patternOrId, patternOrId);
  return result.changes > 0;
}
