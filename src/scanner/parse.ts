import type Database from "libsql";
import { runWithConcurrency } from "./concurrency.js";
import { runScanWorker } from "./worker.js";
import { errorMessage } from "./result.js";
import type { ScanState } from "./engine.js";
import type { ScanHooks } from "./hooks.js";

const DEFAULT_MAX_FILE_WORKERS = 5;
const DEFAULT_MAX_SCAN_WORKERS_PER_FILE = 5;
const HARD_CAP = 8;

const clamp = (n: number | undefined, fallback: number): number =>
  Math.min(HARD_CAP, Math.max(1, n ?? fallback));

/**
 * Phase 3 — two-tier fan-out: up to `maxFile` files in parallel, each file
 * processing up to `maxChunk` chunks in parallel. Chunk-worker tools write
 * transactions and questions directly to the DB (scoped to `scanId`) and tick
 * the shared progress sink.
 */
export async function parsePhase(
  db: Database.Database,
  state: ScanState,
  hooks: ScanHooks,
): Promise<void> {
  await hooks.beforeParse?.(state);

  const maxFile = clamp(state.options.maxFileWorkers, DEFAULT_MAX_FILE_WORKERS);
  const maxChunk = clamp(state.options.maxScanWorkersPerFile, DEFAULT_MAX_SCAN_WORKERS_PER_FILE);

  const fileGroups = state.decrypted
    .map(file => ({
      fileId: file.path,
      scannedFileId: file.scannedFileId,
      chunks: state.chunks.filter(c => c.fileId === file.path),
    }))
    .filter(g => g.chunks.length > 0);

  const fileTasks = fileGroups.map(group => () => {
    const chunkTasks = group.chunks.map(chunk => () => runScanWorker({
      db,
      scanId: state.scanId,
      scannedFileId: group.scannedFileId,
      progress: state.progress,
      chunk,
    }, hooks));
    return runWithConcurrency(chunkTasks, maxChunk);
  });

  const settled = await runWithConcurrency(fileTasks, maxFile);
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (!r.ok) state.errors.push({ phase: "parse", target: fileGroups[i].fileId, error: errorMessage(r.error) });
  }

  for (const file of state.decrypted) {
    if (!file.scannedFileId) continue;
    db.prepare(
      `UPDATE scanned_files SET status = 'scanned', scanned_at = datetime('now') WHERE id = ?`,
    ).run(file.scannedFileId);
  }

  await hooks.afterParse?.(state);
}
