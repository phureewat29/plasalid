import type { Chunk, ScanState, PhaseName } from "./engine.js";
import type { ClarifySummary } from "./clarifier.js";

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
  beforeClarify?(s: Readonly<ScanState>): MaybePromise<void>;
  afterClarify?(s: Readonly<ScanState>, summary: ClarifySummary): MaybePromise<void>;
  onError?(err: unknown, phase: PhaseName, s: Readonly<ScanState>): MaybePromise<void>;
  /**
   * Fired when an AbortSignal trip propagates out of any phase. The CLI uses
   * this to unmount Ink and restore the cursor before runScan's promise
   * settles. onFinish still fires after onAbort.
   */
  onAbort?(s: Readonly<ScanState>): MaybePromise<void>;
  onFinish?(s: Readonly<ScanState>): MaybePromise<void>;
}
