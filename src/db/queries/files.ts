import type Database from "libsql";

export interface ScannedFileTotals {
  scanned: number;
  pending: number;
  failed: number;
}

export interface ScannedFileRow {
  id: string;
  path: string;
  file_hash: string;
  mime: string;
  status: "pending" | "scanned" | "failed";
  scanned_at: string | null;
  source: string | null;
  error: string | null;
  created_at: string;
}

/**
 * Bucket the `scanned_files` table by its `status` enum. Missing buckets are
 * filled with 0 so callers can render a stable shape without null checks.
 */
export function countScannedFiles(db: Database.Database): ScannedFileTotals {
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM scanned_files GROUP BY status`)
    .all() as { status: string; n: number }[];

  const totals: ScannedFileTotals = { scanned: 0, pending: 0, failed: 0 };
  for (const row of rows) {
    if (row.status === "scanned" || row.status === "pending" || row.status === "failed") {
      totals[row.status] = row.n;
    }
  }
  return totals;
}

export function listScannedFiles(db: Database.Database): ScannedFileRow[] {
  return db
    .prepare(
      `SELECT id, path, file_hash, mime, status, scanned_at, source, error, created_at
       FROM scanned_files
       ORDER BY scanned_at DESC, created_at DESC`,
    )
    .all() as ScannedFileRow[];
}

export function findScannedFileById(db: Database.Database, id: string): ScannedFileRow | null {
  const row = db
    .prepare(
      `SELECT id, path, file_hash, mime, status, scanned_at, source, error, created_at
       FROM scanned_files WHERE id = ?`,
    )
    .get(id) as ScannedFileRow | undefined;
  return row ?? null;
}

export interface DeleteScannedFileResult {
  /** The deleted row, or null when no row matched the id. */
  removed: ScannedFileRow | null;
  /** Count of transaction rows that cascaded out. */
  removedTransactions: number;
  /** Count of question rows that cascaded out. */
  removedQuestions: number;
}

/**
 * Delete a `scanned_files` row by id. Cascades remove transactions
 * (`transactions.source_file_id`) and questions (`questions.file_id`) via the
 * schema's ON DELETE CASCADE. Cascaded counts are gathered before the DELETE
 * so callers can report what disappeared.
 */
export function deleteScannedFile(db: Database.Database, id: string): DeleteScannedFileResult {
  const removed = findScannedFileById(db, id);
  if (!removed) {
    return { removed: null, removedTransactions: 0, removedQuestions: 0 };
  }
  const removedTransactions = (db
    .prepare(`SELECT COUNT(*) AS n FROM transactions WHERE source_file_id = ?`)
    .get(id) as { n: number }).n;
  const removedQuestions = (db
    .prepare(`SELECT COUNT(*) AS n FROM questions WHERE file_id = ?`)
    .get(id) as { n: number }).n;
  db.prepare(`DELETE FROM scanned_files WHERE id = ?`).run(id);
  return { removed, removedTransactions, removedQuestions };
}

export interface MarkFileScannedOpts {
  /** Who scanned the file (e.g. the external agent name). */
  source?: string | null;
}

export interface MarkFileFailedOpts {
  /** Who attempted the scan (e.g. the external agent name). */
  source?: string | null;
  error: string;
}

/**
 * Stamp a `scanned_files` row as scanned: status='scanned', scanned_at=now,
 * source recorded (which agent/provider produced the scan).
 */
export function markFileScanned(
  db: Database.Database,
  fileId: string,
  opts: MarkFileScannedOpts,
): number {
  return db
    .prepare(
      `UPDATE scanned_files SET status = 'scanned', scanned_at = datetime('now'), source = ? WHERE id = ?`,
    )
    .run(opts.source ?? null, fileId).changes;
}

/**
 * Stamp a `scanned_files` row as failed: status='failed', source + error
 * recorded (source captures which agent attempted the scan). scanned_at is
 * left untouched — a failed file was never successfully scanned.
 */
export function markFileFailed(
  db: Database.Database,
  fileId: string,
  opts: MarkFileFailedOpts,
): number {
  return db
    .prepare(`UPDATE scanned_files SET status = 'failed', source = ?, error = ? WHERE id = ?`)
    .run(opts.source ?? null, opts.error, fileId).changes;
}
