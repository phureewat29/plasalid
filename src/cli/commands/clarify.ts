import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { runClarify, type ClarifySummary } from "../../scanner/clarifier.js";
import { makePromptUser, makeAgentOnProgress, statusSpinner } from "../ux.js";

/**
 * Zero-arg clarifier. Hands every question to the clarifier (deterministic
 * passes first, then the LLM agent) and prints a colored summary on completion.
 */
export async function runClarifyCommand(): Promise<void> {
  const db = getDb();
  const spinner = statusSpinner("Clarifying...");
  const promptUser = makePromptUser(spinner);
  const onProgress = makeAgentOnProgress(spinner);
  try {
    const summary = await runClarify({
      db,
      interactive: !!process.stdout.isTTY,
      promptUser,
      onProgress,
    });
    spinner.succeed("Clarify done.");
    console.log("");
    console.log(formatSummary(summary));
  } catch (err: unknown) {
    spinner.fail(err instanceof Error ? err.message : "Clarify failed.");
    process.exitCode = 1;
  }
}

function formatSummary(summary: ClarifySummary): string {
  if (summary.total === 0) {
    return chalk.dim("No questions.");
  }
  const tally = Object.entries(summary.tally)
    .map(([k, v]) => `${k}×${v}`)
    .join(", ");
  const lines = [
    chalk.bold(`Clarified ${summary.clarified}/${summary.total} questions${tally ? ` (${tally})` : ""}.`),
  ];
  if (summary.remaining > 0) {
    lines.push(chalk.yellow(`${summary.remaining} question(s) remain.`));
  }
  return lines.join("\n");
}
