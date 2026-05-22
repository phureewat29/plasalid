import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { runScan } from "../../scanner/engine/scanEngine.js";
import type { Chunk, ScanHooks, ScanState } from "../../scanner/engine/types.js";
import type {
  DashboardEvent,
  ScanDashboardController,
} from "../ink/scan_dashboard.js";

export interface ScanCommandOptions {
  regex?: string;
  force?: boolean;
  parallel?: number;
  review?: boolean;
  autoCommit?: boolean;
}

export async function runScanCommand(opts: ScanCommandOptions): Promise<void> {
  if (opts.regex !== undefined) {
    try {
      new RegExp(opts.regex, "i");
    } catch (err: any) {
      console.error(chalk.red(`Invalid regex: ${err.message}`));
      process.exitCode = 1;
      return;
    }
  }

  const parallel = opts.parallel ?? 5;
  const isTTY = !!process.stdout.isTTY;
  const hooks = isTTY ? await buildTtyHooks(parallel) : buildPlainHooks();

  const result = await runScan(
    getDb(),
    {
      regex: opts.regex,
      force: opts.force,
      interactive: true,
      maxFileWorkers: parallel,
      review: opts.review,
      autoCommit: opts.autoCommit,
    },
    hooks,
  );

  renderSummary(result.state);
}

/* TTY mode — Ink dashboard with one in-place row per file. */

async function buildTtyHooks(parallel: number): Promise<ScanHooks> {
  const { render } = await import("ink");
  const { createElement } = await import("react");
  const { ScanDashboard, ScanDashboardController } = await import("../ink/scan_dashboard.js");

  const controller: ScanDashboardController = new ScanDashboardController();
  let inkInstance: { unmount: () => void } | null = null;
  let unsubscribeBus: (() => void) | null = null;
  const fileNameByChunkId = new Map<string, { fileId: string; fileName: string }>();

  return {
    afterDecrypt: (s) => {
      const total = s.decrypted.length + s.skipped.length + s.failed.length;
      if (total === 0) {
        console.log(chalk.dim("No files to scan."));
        return;
      }
      console.log(chalk.dim(`Decrypted ${s.decrypted.length}, skipped ${s.skipped.length}, failed ${s.failed.length}.`));
    },

    afterChunk: (s) => {
      if (s.chunks.length === 0) return;
      console.log(chalk.dim(`Chunked into ${s.chunks.length} page(s).`));
      console.log("");
    },

    beforeParse: (s) => {
      // chunkId → fileId lookup for translating bus events to dashboard events.
      for (const c of s.chunks) fileNameByChunkId.set(c.chunkId, { fileId: c.fileId, fileName: c.fileName });

      if (s.decrypted.length > 0) {
        inkInstance = render(
          createElement(ScanDashboard, {
            controller,
            totalFiles: s.decrypted.length,
            parallel,
          }),
        );
      }

      // Tick the per-file transaction counter as chunk agents call record_transactions.
      unsubscribeBus = s.bus.subscribe(event => {
        if (event.kind === "transaction_appended") {
          const map = fileNameByChunkId.get(event.chunkId);
          if (map) {
            controller.publish({ type: "tx-appended", fileId: map.fileId } as DashboardEvent);
          }
        } else if (event.kind === "unknown_appended" && event.chunkId) {
          const map = fileNameByChunkId.get(event.chunkId);
          if (map) {
            controller.publish({ type: "unknown-appended", fileId: map.fileId } as DashboardEvent);
          }
        }
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
      controller.publish({ type: "chunk-end", fileId: chunk.fileId, ok });
    },

    afterParse: () => {
      unsubscribeBus?.();
      unsubscribeBus = null;
      // Ink preserves the final frame as static output on unmount, so the
      // per-file rows stay visible while subsequent phases print below them.
      inkInstance?.unmount();
      inkInstance = null;
    },

    beforeCommit: () => { console.log(chalk.dim("Committing...")); },
  };
}

/* Non-TTY mode — one collapsed summary line per file when its chunks complete. */

interface FileTally {
  fileName: string;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  txAdded: number;
  unknownsAdded: number;
}

function buildPlainHooks(): ScanHooks {
  const tallies = new Map<string, FileTally>();
  const fileIdByChunkId = new Map<string, string>();
  let unsubscribeBus: (() => void) | null = null;

  const finalize = (fileId: string) => {
    const t = tallies.get(fileId);
    if (!t) return;
    if (t.completedChunks + t.failedChunks < t.totalChunks) return;
    if (t.failedChunks === 0) {
      console.log(
        `  ${chalk.green("✓")} ${t.fileName} ${chalk.dim(
          `${t.completedChunks} of ${t.totalChunks} pages · ${t.txAdded} transactions${t.unknownsAdded > 0 ? `, ${t.unknownsAdded} unknowns` : ""}`,
        )}`,
      );
    } else if (t.failedChunks === t.totalChunks) {
      console.log(`  ${chalk.red("✗")} ${t.fileName} ${chalk.dim(`every chunk failed`)}`);
    } else {
      console.log(
        `  ${chalk.yellow("⚠")} ${t.fileName} ${chalk.dim(
          `${t.completedChunks} of ${t.totalChunks} pages · ${t.failedChunks} chunks failed · ${t.txAdded} transactions`,
        )}`,
      );
    }
  };

  return {
    afterDecrypt: (s) => {
      const total = s.decrypted.length + s.skipped.length + s.failed.length;
      if (total === 0) {
        console.log("No files to scan.");
        return;
      }
      console.log(`Decrypted ${s.decrypted.length}, skipped ${s.skipped.length}, failed ${s.failed.length}.`);
    },

    afterChunk: (s) => {
      if (s.chunks.length > 0) console.log(`Chunked into ${s.chunks.length} page(s).`);
    },

    beforeParse: (s) => {
      for (const c of s.chunks) fileIdByChunkId.set(c.chunkId, c.fileId);
      unsubscribeBus = s.bus.subscribe(event => {
        if (event.kind === "transaction_appended") {
          const fileId = fileIdByChunkId.get(event.chunkId);
          if (!fileId) return;
          const t = tallies.get(fileId);
          if (t) t.txAdded++;
        } else if (event.kind === "unknown_appended" && event.chunkId) {
          const fileId = fileIdByChunkId.get(event.chunkId);
          if (!fileId) return;
          const t = tallies.get(fileId);
          if (t) t.unknownsAdded++;
        }
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
          unknownsAdded: 0,
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
      unsubscribeBus?.();
      unsubscribeBus = null;
    },

    beforeCommit: () => { console.log("Committing..."); },
  };
}

function renderSummary(state: Readonly<ScanState>): void {
  console.log("");
  if (!state.committed) {
    console.log(chalk.yellow(`Scan ${state.scanId} did not commit (review=${state.review ?? "?"}).`));
    return;
  }
  const c = state.committed;
  console.log(chalk.bold(
    `Scanned ${state.decrypted.length} file(s) → ${c.transactions} transactions, ${c.unknowns} unknowns. scan_id=${state.scanId}`,
  ));
  if (Object.keys(state.auditApplied).length > 0) {
    console.log(chalk.dim("Audit applied:"));
    for (const [name, count] of Object.entries(state.auditApplied)) {
      console.log(chalk.dim(`  · ${name}: ${count}`));
    }
  }
  if (state.errors.length > 0) {
    console.log(chalk.yellow(`${state.errors.length} phase error(s):`));
    for (const e of state.errors) {
      console.log(chalk.dim(`  - [${e.phase}] ${e.target ?? ""} ${(e.error as Error)?.message ?? ""}`));
    }
  }
}
