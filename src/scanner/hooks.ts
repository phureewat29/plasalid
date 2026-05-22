import type { Chunk, ScanState, PhaseName } from "./engine.js";
import type { ResolveSummary } from "./resolver.js";

export type MaybePromise<T> = T | Promise<T>;

/**
 * Lifecycle hooks the engine fires at phase edges. CLI registers spinner/Ink
 * hooks; tests register assertions. Every hook is optional and best-effort —
 * a hook that throws gets logged and the phase continues.
 */
export interface ScanHooks {
  onStart?(s: Readonly<ScanState>): MaybePromise<void>;
  beforeDecrypt?(s: Readonly<ScanState>): MaybePromise<void>;
  afterDecrypt?(s: Readonly<ScanState>): MaybePromise<void>;
  beforeChunk?(s: Readonly<ScanState>): MaybePromise<void>;
  afterChunk?(s: Readonly<ScanState>): MaybePromise<void>;
  beforeParse?(s: Readonly<ScanState>): MaybePromise<void>;
  onWorkerStart?(workerId: string, chunk: Chunk): void;
  onWorkerEnd?(workerId: string, chunk: Chunk, ok: boolean): void;
  afterParse?(s: Readonly<ScanState>): MaybePromise<void>;
  beforeResolve?(s: Readonly<ScanState>): MaybePromise<void>;
  afterResolve?(s: Readonly<ScanState>, summary: ResolveSummary): MaybePromise<void>;
  onError?(err: unknown, phase: PhaseName, s: Readonly<ScanState>): MaybePromise<void>;
  onFinish?(s: Readonly<ScanState>): MaybePromise<void>;
}
