import { randomUUID } from "crypto";
import type Database from "libsql";
import { runScanAgent } from "../ai/agent.js";
import { recordQuestion } from "../db/queries/questions.js";
import { buildDocumentBlock } from "./pdf/pdf.js";
import { tryExecute } from "./result.js";
import type { Chunk } from "./engine.js";
import type { ScanHooks } from "./hooks.js";
import type { ScanProgress } from "./progress.js";

export interface ScanWorkerDeps {
  readonly db: Database.Database;
  readonly scanId: string;
  readonly scannedFileId: string | undefined;
  readonly progress: ScanProgress;
  readonly chunk: Chunk;
}

/**
 * Process one chunk: run the LLM scan agent over a single-page PDF blob with
 * scanId + progress sink + scanned_files row injected through the agent
 * context. Agent's record_transactions / note_question calls write directly to
 * the DB; per-row ticks fan out via `progress.emit`. Failures land in the DB
 * as a `chunk_failed` question so the clarifier can pick them up.
 */
export async function runScanWorker(deps: ScanWorkerDeps, hooks: ScanHooks): Promise<void> {
  const workerId = `cw:${randomUUID()}`;
  hooks.onWorkerStart?.(workerId, deps.chunk);

  const outcome = await tryExecute(() => runScanAgent({
    db: deps.db,
    initialMessages: [
      {
        role: "user",
        content: [
          buildDocumentBlock(deps.chunk.bytes, deps.chunk.fileName, deps.chunk.mime),
          { type: "text", text: buildChunkPrompt(deps.chunk) },
        ],
      },
    ],
    prompt: { fileName: deps.chunk.fileName },
    agentCtx: {
      interactive: false,
      scanId: deps.scanId,
      fileId: deps.scannedFileId,
      chunkId: deps.chunk.chunkId,
      progress: deps.progress,
    },
  }));

  hooks.onWorkerEnd?.(workerId, deps.chunk, outcome.ok);
  if (!outcome.ok) recordChunkFailure(deps, outcome.error);
}

function recordChunkFailure(deps: ScanWorkerDeps, error: string): void {
  try {
    recordQuestion(deps.db, {
      file_id: deps.scannedFileId ?? null,
      scan_id: deps.scanId,
      transaction_id: null,
      account_id: null,
      kind: "chunk_failed",
      prompt: `Chunk ${deps.chunk.fileName} p${deps.chunk.pageNumber} failed to parse: ${error}.`,
    });
    deps.progress.emit({ chunkId: deps.chunk.chunkId, kind: "question" });
  } catch {
    // failure to record a failure shouldn't crash the file worker
  }
}

function buildChunkPrompt(chunk: Chunk): string {
  return [
    `You are parsing page ${chunk.pageNumber} of ${chunk.totalPages} of ${chunk.fileName}.`,
    ``,
    `Steps:`,
    `1. Call list_accounts to see what already exists.`,
    `2. If this page reveals an account that isn't in the chart yet, call create_account once.`,
    `3. For every transaction on this page, call record_transactions (plural) with all rows in one batch.`,
    `4. If the first or last row looks incomplete (no date, or no amount column visible — the row likely continues onto an adjacent page), call note_question with kind="boundary_continuation" and the raw row text. Do NOT invent missing fields.`,
    `5. When done with this page, call mark_file_scanned with a short summary.`,
  ].join("\n");
}
