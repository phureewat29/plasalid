import chalk from "chalk";
import inquirer from "inquirer";
import { getDb } from "../../db/connection.js";
import { findUndoMatches, deleteMatches } from "../../scanner/pipeline.js";

export async function runUndoCommand(regex: string): Promise<void> {
  if (!regex) {
    console.error(chalk.red("undo requires a regex argument."));
    process.exitCode = 1;
    return;
  }
  let matches;
  try {
    matches = findUndoMatches(getDb(), regex);
  } catch (err: any) {
    console.error(chalk.red(`Invalid regex: ${err.message}`));
    process.exitCode = 1;
    return;
  }
  if (matches.length === 0) {
    console.log(chalk.dim("No scanned files match that regex."));
    return;
  }
  console.log(chalk.bold(`undo will delete ${matches.length} file(s) and their journal entries:`));
  for (const m of matches) {
    const when = m.scannedAt ? chalk.dim(` (scanned ${m.scannedAt})`) : "";
    console.log(`  • ${m.relPath}${when}`);
  }
  const { proceed } = await inquirer.prompt([
    { type: "confirm", name: "proceed", message: "Proceed?", default: false },
  ]);
  if (!proceed) {
    console.log(chalk.dim("Cancelled."));
    return;
  }
  const deleted = deleteMatches(getDb(), matches.map(m => m.id));
  console.log(chalk.green(`✓ Removed ${deleted} file(s) and all linked records.`));
}
