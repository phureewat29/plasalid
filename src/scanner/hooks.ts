import type { Chunk, ScanState, StageName } from "./engine.js";
import type { ClarifySummary } from "./clarify.js";

export type MaybePromise<T> = T | Promise<T>;

// Every hook is optional; a hook that throws is logged and the stage continues.
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
  afterClarify?(
    s: Readonly<ScanState>,
    summary: ClarifySummary,
  ): MaybePromise<void>;
  onError?(
    err: unknown,
    stage: StageName,
    s: Readonly<ScanState>,
  ): MaybePromise<void>;
  onAbort?(s: Readonly<ScanState>): MaybePromise<void>;
  onFinish?(s: Readonly<ScanState>): MaybePromise<void>;
}
