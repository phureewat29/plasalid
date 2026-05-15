import chalk from "chalk";
import { runScan, type ScanSummary, type ScanRunEvents } from "../../scanner/pipeline.js";

export interface ScanCommandOptions {
  regex?: string;
  force?: boolean;
  parallel?: number;
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

  const useInk = !!process.stdout.isTTY;
  const events = useInk ? await buildInkEvents(opts.parallel ?? 3) : buildPlainTextEvents();

  const summary = await runScan({
    regex: opts.regex,
    force: opts.force,
    interactive: true,
    concurrency: opts.parallel,
    events,
  });
  renderScanSummary(summary);
}

// ── Ink-based events (TTY mode) ────────────────────────────────────────────

async function buildInkEvents(parallel: number): Promise<ScanRunEvents> {
  // Lazy-load ink + react so this module stays importable in non-TTY contexts
  // (and so test environments without React don't choke on the JSX).
  const { render } = await import("ink");
  const { createElement } = await import("react");
  const { ScanDashboard, ScanDashboardController } = await import("../ink/scan_dashboard.js");

  const controller = new ScanDashboardController();
  let inkInstance: { unmount: () => void; waitUntilExit: () => Promise<void> } | null = null;
  let mountedFiles = 0;

  return {
    decryptStart: (count) => {
      if (count > 0) console.log(chalk.dim(`Decrypting ${count} file(s)...`));
    },
    decryptProgress: (e) => {
      const marker =
        e.outcome === "decrypted" ? chalk.dim("·")
        : e.outcome === "skipped" ? chalk.dim("•")
        : chalk.red("✗");
      console.log(`  ${marker} [${e.index + 1}/${e.total}] ${e.fileName} (${e.outcome})`);
    },
    decryptDone: (e) => {
      console.log(chalk.dim(`Decrypted ${e.decrypted}, skipped ${e.skipped}, failed ${e.failed}.`));
      console.log("");
      mountedFiles = e.decrypted;
      if (e.decrypted > 0) {
        inkInstance = render(
          createElement(ScanDashboard, { controller, totalFiles: e.decrypted, parallel }),
        );
      }
    },
    scanStart: (e) => controller.publish({ type: "scan-start", fileName: e.fileName }),
    scanProgress: (e) => controller.publish({ type: "scan-progress", fileName: e.fileName, step: e.step }),
    scanEnd: (e) => controller.publish({
      type: "scan-end",
      fileName: e.fileName,
      status: e.status,
      entries: e.entries,
      concerns: e.concerns,
      error: e.error,
    }),
    correlating: (pairs) => {
      if (inkInstance) { inkInstance.unmount(); inkInstance = null; }
      if (mountedFiles > 0 && pairs > 0) {
        console.log(chalk.dim(`Correlating across files... ${pairs} pair(s) flagged.`));
      }
    },
    committing: () => {
      // In case correlating fired with 0 pairs, ink may still be mounted; unmount now.
      if (inkInstance) { inkInstance.unmount(); inkInstance = null; }
      if (mountedFiles > 0) console.log(chalk.dim("Committing..."));
    },
  };
}

// ── Plain-text progress (TTY or piped, no ink yet) ─────────────────────────

function buildPlainTextEvents(): ScanRunEvents {
  let decryptTotal = 0;
  // De-dupe scan-progress chatter: only print when the step text changes per file.
  const lastStepByFile = new Map<string, string>();
  return {
    decryptStart: (count) => {
      decryptTotal = count;
      if (count > 0) console.log(chalk.dim(`Decrypting ${count} file(s)...`));
    },
    decryptProgress: (e) => {
      const marker =
        e.outcome === "decrypted" ? chalk.dim("·")
        : e.outcome === "skipped" ? chalk.dim("•")
        : chalk.red("✗");
      console.log(`  ${marker} [${e.index + 1}/${e.total}] ${e.fileName} (${e.outcome})`);
    },
    decryptDone: (e) => {
      if (decryptTotal === 0) return;
      console.log(chalk.dim(`Decrypted ${e.decrypted}, skipped ${e.skipped}, failed ${e.failed}.`));
      console.log("");
    },
    scanStart: (e) => {
      console.log(`${chalk.cyan("→")} ${e.fileName} ${chalk.dim("starting...")}`);
    },
    scanProgress: (e) => {
      if (lastStepByFile.get(e.fileName) === e.step) return;
      lastStepByFile.set(e.fileName, e.step);
      console.log(chalk.dim(`    ${e.fileName} · ${e.step}`));
    },
    scanEnd: (e) => {
      lastStepByFile.delete(e.fileName);
      if (e.status === "scanned") {
        console.log(`${chalk.green("✓")} ${e.fileName} ${chalk.dim(`(${e.entries} entries, ${e.concerns} concerns)`)}`);
      } else {
        console.log(`${chalk.red("✗")} ${e.fileName} ${chalk.dim(`— ${e.error ?? "failed"}`)}`);
      }
    },
    correlating: (pairs) => {
      if (pairs > 0) console.log(chalk.dim(`Correlating across files... ${pairs} pair(s) flagged.`));
    },
    committing: () => {
      console.log(chalk.dim("Committing..."));
    },
  };
}

// ── Terse summary ──────────────────────────────────────────────────────────

function renderScanSummary(summary: ScanSummary): void {
  console.log("");
  const headline =
    `Scanned ${summary.total} file(s) — ` +
    `${summary.scanned + summary.replaced} ok, ` +
    `${summary.failed} failed, ` +
    `${summary.concerns} concern${summary.concerns === 1 ? "" : "s"} flagged`;
  console.log(chalk.bold(headline));
  console.log("");

  for (const d of summary.details) {
    const label = d.relPath;
    switch (d.status) {
      case "scanned": {
        const tag = chalk.dim(`${d.entries} entries${d.concerns > 0 ? ` · ${d.concerns} concerns` : ""}`);
        console.log(`  ${chalk.green("✓")} ${label}  ${tag}`);
        break;
      }
      case "replaced": {
        const tag = chalk.dim(`${d.entries} entries${d.concerns > 0 ? ` · ${d.concerns} concerns` : ""} (replaces prior)`);
        console.log(`  ${chalk.cyan("↻")} ${label}  ${tag}`);
        break;
      }
      case "skipped": {
        console.log(`  ${chalk.dim("•")} ${label}  ${chalk.dim("(already scanned)")}`);
        break;
      }
      case "failed": {
        console.log(`  ${chalk.red("✗")} ${label}  ${chalk.dim(`— ${d.error ?? "failed"}`)}`);
        break;
      }
    }
  }

  const newlyProcessed = summary.scanned + summary.replaced;
  if (newlyProcessed > 0) {
    console.log("");
    console.log(
      `${chalk.dim("Next:")} ${chalk.cyan("plasalid review")}${chalk.dim(
        summary.concerns > 0
          ? " — to clear the concerns and learn your recurring rhythms."
          : " — to connect related transactions and learn your recurring rhythms.",
      )}`,
    );
  }
}
