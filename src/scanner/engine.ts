import { randomUUID } from "crypto";
import type Database from "libsql";
import type { ScannedFile } from "./decrypt.js";
import type { ScanHooks } from "./hooks.js";
import type { ScanProgress } from "./progress.js";
import type { ClarifySummary } from "./clarify.js";
import { createProgress } from "./progress.js";
import { decrypt } from "./decrypt.js";
import { parse } from "./parse.js";
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

export interface StageError {
  readonly stage: StageName;
  readonly target?: string;
  readonly error: unknown;
}

export type StageName = "decrypt" | "chunk" | "parse" | "clarify";

export interface RunScanOptions {
  regex?: string;
  force?: boolean;
  interactive?: boolean;
  maxFileWorkers?: number;
  maxScanWorkersPerFile?: number;
  stages?: ReadonlyArray<{ name: StageName; stage: Stage }>;
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
  errors: StageError[];
}

export type Stage = (
  db: Database.Database,
  state: ScanState,
  hooks: ScanHooks,
) => Promise<void>;

export interface ScanResult {
  readonly scanId: string;
  readonly state: ScanState;
}

const chunk: Stage = async (_db, state, hooks) => {
  await hooks.beforeChunk?.(state);
  for (const file of state.decrypted)
    state.chunks.push(...(await chunkPdf(file)));
  await hooks.afterChunk?.(state);
};

const clarify: Stage = async (db, state, hooks) => {
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

export const DEFAULT_STAGES: readonly { name: StageName; stage: Stage }[] = [
  { name: "decrypt", stage: decrypt },
  { name: "chunk", stage: chunk },
  { name: "parse", stage: parse },
  { name: "clarify", stage: clarify },
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

  const stages = opts.stages ?? DEFAULT_STAGES;
  try {
    await runStageChain(db, state, hooks, stages);
    if (state.signal.aborted) throw new AbortedError();
  } catch (err) {
    if (err instanceof AbortedError) await fire(hooks.onAbort, state);
    throw err;
  } finally {
    await fire(hooks.onFinish, state);
  }

  return { scanId, state };
}

async function runStageChain(
  db: Database.Database,
  state: ScanState,
  hooks: ScanHooks,
  stages: ReadonlyArray<{ name: StageName; stage: Stage }>,
): Promise<void> {
  for (const { name, stage } of stages) {
    if (state.signal.aborted) throw new AbortedError();
    const aborted = await tryStage(db, state, hooks, name, stage);
    if (aborted) return;
  }
}

async function tryStage(
  db: Database.Database,
  state: ScanState,
  hooks: ScanHooks,
  name: StageName,
  stage: Stage,
): Promise<boolean> {
  try {
    await stage(db, state, hooks);
    return false;
  } catch (err) {
    if (err instanceof AbortedError) throw err;
    state.errors.push({ stage: name, error: err });
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
