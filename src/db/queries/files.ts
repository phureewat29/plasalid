import type Database from "libsql";

export interface ScannedFileTotals {
  scanned: number;
  pending: number;
  failed: number;
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
