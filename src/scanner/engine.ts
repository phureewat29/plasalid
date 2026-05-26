import { randomUUID } from "crypto";
import type Database from "libsql";
import type { ScannedFile } from "./decrypt.js";
import type { ScanHooks } from "./hooks.js";
import type { ScanProgress } from "./progress.js";
import type { ClarifySummary } from "./clarify.js";
import { createProgress } from "./progress.js";
import { decryptPhase } from "./decrypt.js";
import { parsePhase } from "./parse.js";
import { chunkPdf } from "./pdf.js";
import { runClarify } from "./clarify.js";
import { errorMessage } from "../lib/result.js";
import { AbortedError } from "../ai/errors.js";

const NEVER_ABORTS = new AbortController().signal;

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
  maxFileWorkers?: number;
  maxScanWorkersPerFile?: number;
  phases?: ReadonlyArray<{ name: PhaseName; phase: Phase }>;
}

export interface ScanState {
  readonly scanId: string;
  readonly startedAt: number;
  readonly options: RunScanOptions;
  readonly progress: ScanProgress;
  readonly signal: AbortSignal;

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
    signal: state.signal,
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

export async function runScan(
  db: Database.Database,
  opts: RunScanOptions = {},
  hooks: ScanHooks = {},
  signal: AbortSignal = NEVER_ABORTS,
): Promise<ScanResult> {
  const scanId = `sc:${randomUUID()}`;
  const progress = createProgress();

  const state: ScanState = {
    scanId,
    startedAt: Date.now(),
    options: opts,
    progress,
    signal,
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
  try {
    await runPhaseChain(db, state, hooks, phases);
    if (state.signal.aborted) throw new AbortedError();
  } catch (err) {
    if (err instanceof AbortedError) await fire(hooks.onAbort, state);
    throw err;
  } finally {
    await fire(hooks.onFinish, state);
  }

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
    if (err instanceof AbortedError) throw err;
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
