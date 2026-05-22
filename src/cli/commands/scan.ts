import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { runScan } from "../../scanner/engine.js";
import type { Chunk, ScanState } from "../../scanner/engine.js";
import type { ScanHooks } from "../../scanner/hooks.js";
import type { ScanDashboardController } from "../ink/ScanDashboard.js";

export interface ScanCommandOptions {
  regex?: string;
  force?: boolean;
  parallel?: number;
}

export async function runScanCommand(opts: ScanCommandOptions): Promise<void> {
  if (opts.regex) {
    try {
      new RegExp(opts.regex, "i");
    } catch (err: unknown) {
      console.error(
        chalk.red(
          `Invalid regex: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      process.exitCode = 1;
      return;
    }
  }

  const parallel = opts.parallel ?? 5;
  const isTTY = !!process.stdout.isTTY;
  const hooks = isTTY ? await buildTtyHooks() : buildPlainHooks();

  const result = await runScan(
    getDb(),
    {
      regex: opts.regex,
      force: opts.force,
      interactive: true,
      maxFileWorkers: parallel,
    },
    hooks,
  );

  renderSummary(result.state);
}

/* TTY mode — Ink dashboard with one in-place row per file. */

async function buildTtyHooks(): Promise<ScanHooks> {
  const { render } = await import("ink");
  const { createElement } = await import("react");
  const { ScanDashboard, createScanDashboardController } =
    await import("../ink/ScanDashboard.js");

  const controller: ScanDashboardController = createScanDashboardController();
  let inkInstance: { unmount: () => void } | null = null;
  let unsubscribeProgress: (() => void) | null = null;
  const chunkLookup = new Map<string, { fileId: string; pageNumber: number }>();

  return {
    afterDecrypt: (s) => {
      const total = s.decrypted.length + s.skipped.length + s.failed.length;
      if (total === 0) {
        console.log(chalk.dim("No files to scan."));
        return;
      }
      console.log(
        chalk.dim(
          `Decrypted ${s.decrypted.length}, skipped ${s.skipped.length}, failed ${s.failed.length}.`,
        ),
      );
    },

    afterChunk: (s) => {
      if (s.chunks.length === 0) return;
      console.log(
        chalk.dim(
          `Chunked into ${s.chunks.length} page(s). Mounting dashboard…`,
        ),
      );
    },

    beforeParse: (s) => {
      for (const c of s.chunks)
        chunkLookup.set(c.chunkId, {
          fileId: c.fileId,
          pageNumber: c.pageNumber,
        });

      if (s.decrypted.length === 0) return;

      process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");

      const files = s.decrypted.map((d) => ({
        fileId: d.path,
        fileName: d.fileName,
        totalPages: s.chunks.filter((c) => c.fileId === d.path).length,
      }));

      inkInstance = render(
        createElement(ScanDashboard, {
          controller,
          files,
        }),
        {
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );

      unsubscribeProgress = s.progress.subscribe((event) => {
        const map = chunkLookup.get(event.chunkId);
        if (!map) return;
        controller.publish({
          type: event.kind === "tx" ? "chunk-tx" : "chunk-question",
          fileId: map.fileId,
          pageNumber: map.pageNumber,
        });
      });
    },

    onWorkerStart: (_id, chunk) => {
      controller.publish({
        type: "chunk-start",
        fileId: chunk.fileId,
        fileName: chunk.fileName,
        pageNumber: chunk.pageNumber,
        totalPages: chunk.totalPages,
      });
    },

    onWorkerEnd: (_id, chunk, ok) => {
      controller.publish({
        type: "chunk-end",
        fileId: chunk.fileId,
        pageNumber: chunk.pageNumber,
        ok,
      });
    },

    afterParse: () => {
      unsubscribeProgress?.();
      unsubscribeProgress = null;
    },

    beforeResolve: () => {
      controller.publish({ type: "phase-set", phase: "resolve" });
    },

    afterResolve: () => {
      controller.publish({ type: "phase-set", phase: "done" });
      inkInstance?.unmount();
      inkInstance = null;
      process.stdout.write("\x1b[?25h");
    },
  };
}

/* Non-TTY mode — one collapsed summary line per file when its chunks complete. */

interface FileTally {
  fileName: string;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  txAdded: number;
  questionsAdded: number;
}

type FinalizeKind = "success" | "all-failed" | "partial";

const FINALIZE_RULES: readonly {
  when: (t: FileTally) => boolean;
  kind: FinalizeKind;
}[] = [
  { when: (t) => t.failedChunks === 0, kind: "success" },
  { when: (t) => t.failedChunks === t.totalChunks, kind: "all-failed" },
  { when: () => true, kind: "partial" },
];

const FINALIZE_RENDER: Record<FinalizeKind, (t: FileTally) => string> = {
  success: (t) =>
    `  ${chalk.green("ok")} ${t.fileName} ${chalk.dim(
      `${t.completedChunks} of ${t.totalChunks} pages · ${t.txAdded} transactions${t.questionsAdded > 0 ? `, ${t.questionsAdded} questions` : ""}`,
    )}`,
  "all-failed": (t) =>
    `  ${chalk.red("fail")} ${t.fileName} ${chalk.dim("every chunk failed")}`,
  partial: (t) =>
    `  ${chalk.yellow("partial")} ${t.fileName} ${chalk.dim(
      `${t.completedChunks} of ${t.totalChunks} pages · ${t.failedChunks} chunks failed · ${t.txAdded} transactions`,
    )}`,
};

function classifyFinalize(t: FileTally): FinalizeKind {
  for (const r of FINALIZE_RULES) if (r.when(t)) return r.kind;
  return "partial";
}

function buildPlainHooks(): ScanHooks {
  const tallies = new Map<string, FileTally>();
  const fileIdByChunkId = new Map<string, string>();
  let unsubscribeProgress: (() => void) | null = null;

  const finalize = (fileId: string) => {
    const t = tallies.get(fileId);
    if (!t || t.completedChunks + t.failedChunks < t.totalChunks) return;
    console.log(FINALIZE_RENDER[classifyFinalize(t)](t));
  };

  return {
    afterDecrypt: (s) => {
      const total = s.decrypted.length + s.skipped.length + s.failed.length;
      if (total === 0) {
        console.log("No files to scan.");
        return;
      }
      console.log(
        `Decrypted ${s.decrypted.length}, skipped ${s.skipped.length}, failed ${s.failed.length}.`,
      );
    },

    afterChunk: (s) => {
      if (s.chunks.length > 0)
        console.log(`Chunked into ${s.chunks.length} page(s).`);
    },

    beforeParse: (s) => {
      for (const c of s.chunks) fileIdByChunkId.set(c.chunkId, c.fileId);
      unsubscribeProgress = s.progress.subscribe((event) => {
        const fileId = fileIdByChunkId.get(event.chunkId);
        if (!fileId) return;
        const t = tallies.get(fileId);
        if (!t) return;
        if (event.kind === "tx") t.txAdded++;
        else t.questionsAdded++;
      });
    },

    onWorkerStart: (_id, chunk: Chunk) => {
      if (!tallies.has(chunk.fileId)) {
        tallies.set(chunk.fileId, {
          fileName: chunk.fileName,
          totalChunks: chunk.totalPages,
          completedChunks: 0,
          failedChunks: 0,
          txAdded: 0,
          questionsAdded: 0,
        });
      }
    },

    onWorkerEnd: (_id, chunk, ok) => {
      const t = tallies.get(chunk.fileId);
      if (!t) return;
      if (ok) t.completedChunks++;
      else t.failedChunks++;
      finalize(chunk.fileId);
    },

    afterParse: () => {
      unsubscribeProgress?.();
      unsubscribeProgress = null;
    },

    beforeResolve: () => {
      console.log("Resolving...");
    },
  };
}

function renderSummary(state: Readonly<ScanState>): void {
  console.log("");
  const txCount = countTransactions(state);
  console.log(
    chalk.bold(
      `Scanned ${state.decrypted.length} file(s) → ${txCount} transactions.`,
    ),
  );

  const r = state.resolveSummary;
  if (r && r.total > 0) {
    console.log(`Resolved ${r.resolved}/${r.total} questions.`);
    if (r.remaining > 0) {
      console.log(
        chalk.yellow(
          `${r.remaining} question(s) remain — run ${chalk.cyan("plasalid resolve")} to finish them.`,
        ),
      );
    }
  }

  if (state.errors.length > 0) {
    console.log(chalk.yellow(`${state.errors.length} phase error(s):`));
    for (const e of state.errors) {
      console.log(
        chalk.dim(
          `  - [${e.phase}] ${e.target ?? ""} ${(e.error as Error)?.message ?? ""}`,
        ),
      );
    }
  }

  if (txCount > 0) {
    console.log("");
    console.log(
      chalk.dim(
        `Next: run ${chalk.cyan("plasalid")} to chat with your ledger about what just landed.`,
      ),
    );
  }
}

/**
 * Snapshot transaction count attributable to this scan. Reads from
 * scanned_files via the file ids assigned in decryptPhase.
 */
function countTransactions(state: Readonly<ScanState>): number {
  const ids = state.decrypted
    .map((d) => d.scannedFileId)
    .filter((s): s is string => !!s);
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE source_file_id IN (${placeholders})`,
    )
    .get(...ids) as { n: number };
  return row.n;
}
