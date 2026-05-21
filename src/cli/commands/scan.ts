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

  const events = process.stdout.isTTY
    ? await inkScanEvents(opts.parallel ?? 3)
    : plainScanEvents();

  const summary = await runScan({
    regex: opts.regex,
    force: opts.force,
    interactive: true,
    concurrency: opts.parallel,
    events,
  });
  renderScanSummary(summary);
}

function logDecryptProgress(
  e: { index: number; total: number; fileName: string; outcome: string },
): void {
  const marker =
    e.outcome === "decrypted" ? chalk.dim("·")
    : e.outcome === "skipped" ? chalk.dim("•")
    : chalk.red("✗");
  console.log(`  ${marker} [${e.index + 1}/${e.total}] ${e.fileName} (${e.outcome})`);
}

/**
 * Hooks every mode shares: the decrypt phase, commit notice, and inspector
 * summary all render the same way in TTY and non-TTY runs. Each mode-specific
 * factory below spreads this base and overrides the scan-phase hooks
 * (`scanStart` / `scanProgress` / `scanEnd`) to render differently.
 *
 * Returns `Partial<ScanRunEvents>` because the scan-phase hooks are filled in
 * by the caller — composition, not inheritance.
 */
function baseScanEvents(): Partial<ScanRunEvents> {
  let decryptTotal = 0;
  return {
    decryptStart: (count) => {
      decryptTotal = count;
      if (count > 0) console.log(chalk.dim(`Decrypting ${count} file(s)...`));
    },
    decryptProgress: logDecryptProgress,
    decryptDone: (e) => {
      if (decryptTotal === 0) return;
      console.log(chalk.dim(`Decrypted ${e.decrypted}, skipped ${e.skipped}, failed ${e.failed}.`));
    },
    committing: () => { console.log(chalk.dim("Committing...")); },
    inspecting: (r) => {
      if (r.total > 0) console.log(chalk.dim(`Inspectors flagged ${r.total} unknown(s).`));
    },
  };
}

/** TTY mode: mount the Ink dashboard during the scan phase. */
async function inkScanEvents(parallel: number): Promise<ScanRunEvents> {
  // Lazy-load ink + react so this module stays importable in non-TTY contexts.
  const { render } = await import("ink");
  const { createElement } = await import("react");
  const { ScanDashboard, ScanDashboardController } = await import("../ink/scan_dashboard.js");

  const controller = new ScanDashboardController();
  let inkInstance: { unmount: () => void; waitUntilExit: () => Promise<void> } | null = null;
  let mountedFiles = 0;

  const base = baseScanEvents();
  return {
    ...base,
    decryptDone: (e) => {
      base.decryptDone?.(e);
      console.log("");
      mountedFiles = e.decrypted;
      if (e.decrypted > 0) {
        inkInstance = render(
          createElement(ScanDashboard, { controller, totalFiles: e.decrypted, parallel }),
        );
      }
    },
    scanStart:    (e) => controller.publish({ type: "scan-start", fileName: e.fileName }),
    scanProgress: (e) => controller.publish({ type: "scan-progress", fileName: e.fileName, step: e.step }),
    scanEnd:      (e) => controller.publish({
      type: "scan-end",
      fileName: e.fileName,
      status: e.status,
      transactions: e.transactions,
      unknowns: e.unknowns,
      error: e.error,
    }),
    committing: () => {
      if (inkInstance) { inkInstance.unmount(); inkInstance = null; }
      if (mountedFiles > 0) base.committing?.();
    },
  } as ScanRunEvents;
}

/** Non-TTY mode: print one line per file as it progresses. */
function plainScanEvents(): ScanRunEvents {
  // De-dupe scan-progress chatter: only print when the step text changes per file.
  const lastStepByFile = new Map<string, string>();
  return {
    ...baseScanEvents(),
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
      const line = e.status === "scanned"
        ? `${chalk.green("✓")} ${e.fileName} ${chalk.dim(`(${e.transactions} transactions, ${e.unknowns} unknowns)`)}`
        : `${chalk.red("✗")} ${e.fileName} ${chalk.dim(`— ${e.error ?? "failed"}`)}`;
      console.log(line);
    },
  } as ScanRunEvents;
}

/** Terse summary */
function renderScanSummary(summary: ScanSummary): void {
  console.log("");
  const headline =
    `Scanned ${summary.total} file(s) — ` +
    `${summary.scanned + summary.replaced} ok, ` +
    `${summary.failed} failed, ` +
    `${summary.unknowns} unknown${summary.unknowns === 1 ? "" : "s"} flagged`;
  console.log(chalk.bold(headline));
  console.log("");

  for (const d of summary.details) {
    const label = d.relPath;
    switch (d.status) {
      case "scanned": {
        const tag = chalk.dim(`${d.transactions} transactions${d.unknowns > 0 ? ` · ${d.unknowns} unknowns` : ""}`);
        console.log(`  ${chalk.green("✓")} ${label}  ${tag}`);
        break;
      }
      case "replaced": {
        const tag = chalk.dim(`${d.transactions} transactions${d.unknowns > 0 ? ` · ${d.unknowns} unknowns` : ""} (replaces prior)`);
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
      `${chalk.dim("Next:")} ${chalk.cyan("plasalid resolve")}${chalk.dim(
        summary.unknowns > 0
          ? " — to walk every open unknown and apply your decision."
          : " — no unknowns surfaced this run; nothing to do.",
      )}`,
    );
  }
}
