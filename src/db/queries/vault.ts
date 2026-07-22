import type Database from "libsql";

interface VaultPasswordRow {
  id: string;
  pattern: string;
  use_count: number;
  last_used_at: string | null;
}

/** Never selects `password_encrypted` — a vault browser, not a decrypt path
 *  (see `ingest/pdf.ts`'s `findCandidates` for that). */
export function listPasswords(db: Database.Database): VaultPasswordRow[] {
  return db
    .prepare(
      `SELECT id, pattern, use_count, last_used_at
       FROM file_passwords
       ORDER BY use_count DESC, last_used_at DESC NULLS LAST, created_at ASC`,
    )
    .all() as VaultPasswordRow[];
}

/** Deletes a stored password by id or by exact pattern match. */
export function deletePassword(db: Database.Database, patternOrId: string): boolean {
  const result = db
    .prepare(`DELETE FROM file_passwords WHERE id = ? OR pattern = ?`)
    .run(patternOrId, patternOrId);
  return result.changes > 0;
}
