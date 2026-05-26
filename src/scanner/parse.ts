import type Database from "libsql";
import { runWithConcurrency } from "./concurrency.js";
import { runScanWorker } from "./worker.js";
import { getActiveModel } from "../config.js";
import { getProvider } from "../ai/providers/index.js";
import type { ScanState } from "./engine.js";
import type { ScanHooks } from "./hooks.js";

const MAX_FILE_WORKERS = 5;
const MAX_SCAN_WORKERS_PER_FILE = 5;
const HARD_CAP = 8;

const clamp = (n: number | undefined, fallback: number): number =>
  Math.min(HARD_CAP, Math.max(1, n ?? fallback));

export async function parsePhase(
  db: Database.Database,
  state: ScanState,
  hooks: ScanHooks,
): Promise<void> {
  await hooks.beforeParse?.(state);

  const maxFile = clamp(state.options.maxFileWorkers, MAX_FILE_WORKERS);
  const maxChunk = clamp(
    state.options.maxScanWorkersPerFile,
    MAX_SCAN_WORKERS_PER_FILE,
  );

  const fileGroups = state.decrypted
    .map((file) => ({
      fileId: file.path,
      scannedFileId: file.scannedFileId,
      chunks: state.chunks.filter((c) => c.fileId === file.path),
    }))
    .filter((g) => g.chunks.length > 0);

  const fileTasks = fileGroups.map((group) => () => {
    const chunkTasks = group.chunks.map(
      (chunk) => () =>
        runScanWorker(
          {
            db,
            scanId: state.scanId,
            scannedFileId: group.scannedFileId,
            progress: state.progress,
            chunk,
            signal: state.signal,
          },
          hooks,
        ),
    );
    return runWithConcurrency(chunkTasks, maxChunk, state.signal);
  });

  const settled = await runWithConcurrency(fileTasks, maxFile, state.signal);
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r && !r.ok)
      state.errors.push({
        phase: "parse",
        target: fileGroups[i].fileId,
        error: r.error,
      });
  }

  // Scanner is DB-direct: partial transactions stay committed on abort/failure.
  const aborted = state.signal?.aborted ?? false;
  const provider = getProvider().name;
  const model = getActiveModel();
  const stampScanned = db.prepare(
    `UPDATE scanned_files SET status = 'scanned', scanned_at = datetime('now'), provider = ?, model = ? WHERE id = ?`,
  );
  const stampFailed = db.prepare(
    `UPDATE scanned_files SET status = 'failed', error = ? WHERE id = ?`,
  );
  for (let i = 0; i < fileGroups.length; i++) {
    const sfId = fileGroups[i].scannedFileId;
    if (!sfId) continue;
    const r = settled[i];
    if (r?.ok) {
      stampScanned.run(provider, model, sfId);
    } else if (r && !r.ok) {
      stampFailed.run(r.error, sfId);
    } else if (!aborted) {
      stampFailed.run("worker did not produce a settled result", sfId);
    }
    // else: aborted + unsettled → leave pending for resume
  }

  await hooks.afterParse?.(state);
}
