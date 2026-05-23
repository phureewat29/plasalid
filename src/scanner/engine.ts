import { randomUUID } from "crypto";
import type Database from "libsql";
import type { ScannedFile } from "./walker.js";
import type { ScanHooks } from "./hooks.js";
import type { ScanProgress } from "./progress.js";
import type { ClarifySummary } from "./clarifier.js";
import { createProgress } from "./progress.js";
import { decryptPhase } from "./decrypt.js";
import { parsePhase } from "./parse.js";
import { chunkPdf } from "./pdf/chunker.js";
import { runClarify } from "./clarifier.js";
import { errorMessage } from "./result.js";

export interface Chunk {
  readonly chunkId: string; // `${fileId}#p${pageNumber}`
  readonly fileId: string;
  readonly fileName: string;
  readonly relPath: string;
  readonly pageNumber: number; // 1-indexed
  readonly totalPages: number;
  readonly bytes: Buffer;
  readonly mime: string;
}

export interface DecryptedFile {
  readonly path: string;
  readonly fileName: string;
  readonly relPath: string;
  readonly hash: string;
  readonly mime: string;
  readonly decryptedBytes: Buffer;
  readonly replacesPriorScannedFileId?: string;
  /** scanned_files.id assigned in decryptPhase so scan-worker tools can stamp source_file_id. */
  scannedFileId?: string;
}

export interface SkippedFile {
  readonly file: ScannedFile;
  readonly existingScannedFileId: string;
}

export interface FailedFile {
  readonly file: ScannedFile;
  readonly error: string;
}

export interface PhaseError {
  readonly phase: PhaseName;
  readonly target?: string;
  readonly error: unknown;
}

export type PhaseName = "decrypt" | "chunk" | "parse" | "clarify";

export interface RunScanOptions {
  regex?: string;
  force?: boolean;
  interactive?: boolean;
  /** Max files processed concurrently. Default 5, hard cap 8. */
  maxFileWorkers?: number;
  /** Max scan workers per file (one per chunk). Default 5, hard cap 8. */
  maxScanWorkersPerFile?: number;
  /**
   * Override the phase chain. Default = the four built-ins. Tests and alternate
   * flows (dry-run, OCR-only) inject their own without editing this file.
   */
  phases?: ReadonlyArray<{ name: PhaseName; phase: Phase }>;
}

/**
 * The state object threaded through every phase. Phases mutate it in place;
 * hooks read it. `progress` is the single-consumer event sink scan-worker
 * tools emit into; the CLI subscribes to drive the dashboard.
 */
export interface ScanState {
  readonly scanId: string;
  readonly startedAt: number;
  readonly options: RunScanOptions;
  readonly progress: ScanProgress;

  files: ScannedFile[];
  decrypted: DecryptedFile[];
  skipped: SkippedFile[];
  failed: FailedFile[];
  chunks: Chunk[];

  clarifySummary: ClarifySummary | null;
  errors: PhaseError[];
}

export type Phase = (
  db: Database.Database,
  state: ScanState,
  hooks: ScanHooks,
) => Promise<void>;

export interface ScanResult {
  readonly scanId: string;
  readonly state: ScanState;
}

const chunkPhase: Phase = async (_db, state, hooks) => {
  await hooks.beforeChunk?.(state);
  for (const file of state.decrypted)
    state.chunks.push(...(await chunkPdf(file)));
  await hooks.afterChunk?.(state);
};

const clarifyPhase: Phase = async (db, state, hooks) => {
  await hooks.beforeClarify?.(state);
  const summary = await runClarify({
    db,
    scanId: state.scanId,
    interactive: state.options.interactive ?? true,
  });
  state.clarifySummary = summary;
  await hooks.afterClarify?.(state, summary);
};

export const DEFAULT_PHASES: readonly { name: PhaseName; phase: Phase }[] = [
  { name: "decrypt", phase: decryptPhase },
  { name: "chunk", phase: chunkPhase },
  { name: "parse", phase: parsePhase },
  { name: "clarify", phase: clarifyPhase },
];

/**
 * Composition root. Builds the progress sink once per scan run, threads it
 * through ScanState, then runs the phase chain. Nothing survives between
 * scans.
 */
export async function runScan(
  db: Database.Database,
  opts: RunScanOptions = {},
  hooks: ScanHooks = {},
): Promise<ScanResult> {
  const scanId = `sc:${randomUUID()}`;
  const progress = createProgress();

  const state: ScanState = {
    scanId,
    startedAt: Date.now(),
    options: opts,
    progress,
    files: [],
    decrypted: [],
    skipped: [],
    failed: [],
    chunks: [],
    clarifySummary: null,
    errors: [],
  };

  await fire(hooks.onStart, state);

  const phases = opts.phases ?? DEFAULT_PHASES;
  await runPhaseChain(db, state, hooks, phases);

  await fire(hooks.onFinish, state);

  return { scanId, state };
}

async function runPhaseChain(
  db: Database.Database,
  state: ScanState,
  hooks: ScanHooks,
  phases: ReadonlyArray<{ name: PhaseName; phase: Phase }>,
): Promise<void> {
  for (const { name, phase } of phases) {
    const aborted = await tryPhase(db, state, hooks, name, phase);
    if (aborted) return;
  }
}

async function tryPhase(
  db: Database.Database,
  state: ScanState,
  hooks: ScanHooks,
  name: PhaseName,
  phase: Phase,
): Promise<boolean> {
  try {
    await phase(db, state, hooks);
    return false;
  } catch (err) {
    state.errors.push({ phase: name, error: err });
    await fire(hooks.onError, err, name, state);
    return true;
  }
}

async function fire<A extends unknown[]>(
  fn: ((...args: A) => unknown | Promise<unknown>) | undefined,
  ...args: A
): Promise<void> {
  if (!fn) return;
  try {
    await fn(...args);
  } catch (err) {
    console.error(`[scan-engine] ${errorMessage(err)}`);
  }
}
