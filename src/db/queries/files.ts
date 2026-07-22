import type Database from "libsql";

interface FileTotals {
  ingested: number;
  pending: number;
  failed: number;
}

interface FileRow {
  id: string;
  path: string;
  file_hash: string;
  mime: string;
  status: "pending" | "ingested" | "failed";
  ingested_at: string | null;
  source: string | null;
  error: string | null;
  created_at: string;
}

/**
 * Bucket the `files` table by its `status` enum. Missing buckets are
 * filled with 0 so callers can render a stable shape without null checks.
 */
export function countFiles(db: Database.Database): FileTotals {
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM files GROUP BY status`)
    .all() as { status: string; n: number }[];

  const totals: FileTotals = { ingested: 0, pending: 0, failed: 0 };
  for (const row of rows) {
    if (row.status === "ingested" || row.status === "pending" || row.status === "failed") {
      totals[row.status] = row.n;
    }
  }
  return totals;
}

export function listFiles(db: Database.Database): FileRow[] {
  return db
    .prepare(
      `SELECT id, path, file_hash, mime, status, ingested_at, source, error, created_at
       FROM files
       ORDER BY ingested_at DESC, created_at DESC`,
    )
    .all() as FileRow[];
}

export function findFileById(db: Database.Database, id: string): FileRow | null {
  const row = db
    .prepare(
      `SELECT id, path, file_hash, mime, status, ingested_at, source, error, created_at
       FROM files WHERE id = ?`,
    )
    .get(id) as FileRow | undefined;
  return row ?? null;
}

interface DeleteFileResult {
  /** The deleted row, or null when no row matched the id. */
  removed: FileRow | null;
  /** Count of transaction rows that cascaded out. */
  removedTransactions: number;
  /** Count of question rows that cascaded out. */
  removedQuestions: number;
}

/**
 * Deletes a `files` row; ON DELETE CASCADE removes its transactions and
 * questions. Cascaded counts are gathered before the DELETE so callers can
 * report what disappeared.
 */
export function deleteFile(db: Database.Database, id: string): DeleteFileResult {
  const removed = findFileById(db, id);
  if (!removed) {
    return { removed: null, removedTransactions: 0, removedQuestions: 0 };
  }
  const removedTransactions = (db
    .prepare(`SELECT COUNT(*) AS n FROM transactions WHERE source_file_id = ?`)
    .get(id) as { n: number }).n;
  const removedQuestions = (db
    .prepare(`SELECT COUNT(*) AS n FROM questions WHERE file_id = ?`)
    .get(id) as { n: number }).n;
  db.prepare(`DELETE FROM files WHERE id = ?`).run(id);
  return { removed, removedTransactions, removedQuestions };
}

interface MarkFileIngestedOpts {
  /** Who ingested the file (e.g. the external agent name). */
  source?: string | null;
}

interface MarkFileFailedOpts {
  /** Who attempted the ingest (e.g. the external agent name). */
  source?: string | null;
  error: string;
}

/**
 * Stamp a `files` row as ingested: status='ingested', ingested_at=now,
 * source recorded (which agent/provider produced the ingest).
 */
export function markFileIngested(
  db: Database.Database,
  fileId: string,
  opts: MarkFileIngestedOpts,
): number {
  return db
    .prepare(
      `UPDATE files SET status = 'ingested', ingested_at = datetime('now'), source = ? WHERE id = ?`,
    )
    .run(opts.source ?? null, fileId).changes;
}

/** Stamps a `files` row as failed (status, source, error); ingested_at is
 *  left untouched since a failed file was never successfully ingested. */
export function markFileFailed(
  db: Database.Database,
  fileId: string,
  opts: MarkFileFailedOpts,
): number {
  return db
    .prepare(`UPDATE files SET status = 'failed', source = ?, error = ? WHERE id = ?`)
    .run(opts.source ?? null, opts.error, fileId).changes;
}
