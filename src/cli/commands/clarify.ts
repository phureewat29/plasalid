import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { countQuestions } from "../../db/queries/questions.js";
import { runClarify, type ClarifySummary } from "../../scanner/clarifier.js";
import { makePromptUser, makeAgentOnProgress, statusSpinner } from "../ux.js";

/**
 * Zero-arg clarifier. Prints an up-front banner with the open-question count
 * so the user knows what's about to happen, then hands every question to the
 * clarifier (deterministic passes first, then the LLM agent). The agent works
 * silently in the background and only surfaces via inquirer prompts when it
 * genuinely needs a decision.
 */
export async function runClarifyCommand(): Promise<void> {
  const db = getDb();
  const openCount = countQuestions(db);
  if (openCount > 0) {
    console.log("");
    console.log(chalk.bold(`Found ${chalk.cyan(openCount)} open question${openCount === 1 ? "" : "s"}.`));
    console.log(
      chalk.dim("Resolving in the background — I'll only prompt you when I need a decision from you."),
    );
  }
  const spinner = statusSpinner("Resolving...");
  const promptUser = makePromptUser(spinner);
  const onProgress = makeAgentOnProgress(spinner);
  try {
    const summary = await runClarify({
      db,
      interactive: !!process.stdout.isTTY,
      promptUser,
      onProgress,
    });
    spinner.succeed("Done.");
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
  const lines = [chalk.bold(`Clarified ${summary.clarified}/${summary.total} questions.`)];
  if (summary.remaining > 0) {
    lines.push(chalk.yellow(`${summary.remaining} question(s) remain.`));
  }
  return lines.join("\n");
}
