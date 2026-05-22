import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { runResolve, type ResolveSummary } from "../../scanner/resolver.js";
import { makePromptUser, makeAgentOnProgress, statusSpinner } from "../ux.js";

/**
 * Zero-arg resolver. Hands every open question to the resolver (deterministic
 * passes first, then the LLM agent) and prints a colored summary on completion.
 */
export async function runResolveCommand(): Promise<void> {
  const db = getDb();
  const spinner = statusSpinner("Resolving...");
  const promptUser = makePromptUser(spinner);
  const onProgress = makeAgentOnProgress(spinner);
  try {
    const summary = await runResolve({
      db,
      interactive: !!process.stdout.isTTY,
      promptUser,
      onProgress,
    });
    spinner.succeed("Resolve done.");
    console.log("");
    console.log(formatSummary(summary));
  } catch (err: unknown) {
    spinner.fail(err instanceof Error ? err.message : "Resolve failed.");
    process.exitCode = 1;
  }
}

function formatSummary(summary: ResolveSummary): string {
  if (summary.total === 0) {
    return chalk.dim("No open questions.");
  }
  const tally = Object.entries(summary.tally)
    .map(([k, v]) => `${k}×${v}`)
    .join(", ");
  const lines = [
    chalk.bold(`Resolved ${summary.resolved}/${summary.total} questions${tally ? ` (${tally})` : ""}.`),
  ];
  if (summary.remaining > 0) {
    lines.push(chalk.yellow(`${summary.remaining} question(s) remain.`));
  }
  return lines.join("\n");
}
