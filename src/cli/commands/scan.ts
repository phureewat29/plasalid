import chalk from "chalk";
import { runScan, type ScanSummary } from "../../scanner/pipeline.js";

export async function runScanCommand(opts: { regex?: string; force?: boolean }): Promise<void> {
  if (opts.regex !== undefined) {
    try {
      new RegExp(opts.regex, "i");
    } catch (err: any) {
      console.error(chalk.red(`Invalid regex: ${err.message}`));
      process.exitCode = 1;
      return;
    }
  }
  const summary = await runScan({ regex: opts.regex, force: opts.force, interactive: true });
  renderScanSummary(summary);
}

function renderScanSummary(summary: ScanSummary): void {
  console.log("");
  console.log(chalk.bold(`Scanned ${summary.total} file(s)`));
  console.log(
    `  ${chalk.green(`${summary.scanned} scanned`)}  ` +
    `${chalk.cyan(`${summary.replaced} replaced`)}  ` +
    `${chalk.dim(`${summary.skipped} skipped`)}  ` +
    `${chalk.yellow(`${summary.needsInput} needs input`)}  ` +
    `${chalk.red(`${summary.failed} failed`)}`,
  );
  for (const d of summary.details) {
    const label = d.relPath;
    switch (d.result.status) {
      case "scanned":
        console.log(`  ${chalk.green("✓")} ${label}${d.result.summary ? chalk.dim(` — ${d.result.summary}`) : ""}`);
        break;
      case "replaced":
        console.log(`  ${chalk.cyan("↻")} ${label} (replaces previous records)`);
        break;
      case "skipped":
        console.log(`  ${chalk.dim("•")} ${label} (already scanned)`);
        break;
      case "needs_input":
        console.log(`  ${chalk.yellow("!")} ${label} (${d.result.pendingQuestions} pending)`);
        break;
      case "failed":
        console.log(`  ${chalk.red("✗")} ${label}${d.result.error ? chalk.dim(` — ${d.result.error}`) : ""}`);
        break;
    }
  }
}
