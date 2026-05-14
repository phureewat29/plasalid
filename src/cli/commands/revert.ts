import type Database from "libsql";
import chalk from "chalk";
import inquirer from "inquirer";
import { relative, sep } from "path";
import { getDb } from "../../db/connection.js";
import { getDataDir } from "../../config.js";
import { compileMatcher } from "../../scanner/pipeline.js";

interface RevertMatch {
  id: string;
  path: string;
  relPath: string;
  scannedAt: string | null;
}

function pathToRelPath(absolutePath: string): string {
  return relative(getDataDir(), absolutePath).split(sep).join("/");
}

function findRevertMatches(db: Database.Database, regex: string): RevertMatch[] {
  const matcher = compileMatcher(regex);
  const rows = db
    .prepare(
      `SELECT id, path, scanned_at FROM scanned_files ORDER BY scanned_at DESC, created_at DESC`,
    )
    .all() as { id: string; path: string; scanned_at: string | null }[];
  return rows
    .map((r) => ({
      id: r.id,
      path: r.path,
      relPath: pathToRelPath(r.path),
      scannedAt: r.scanned_at,
    }))
    .filter((r) => matcher.test(r.relPath));
}

function deleteMatches(db: Database.Database, ids: string[]): number {
  if (ids.length === 0) return 0;
  const stmt = db.prepare(`DELETE FROM scanned_files WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const id of ids) stmt.run(id);
  });
  tx();
  return ids.length;
}

export async function runRevertCommand(regex: string): Promise<void> {
  if (!regex) {
    console.error(chalk.red("revert requires a regex argument."));
    process.exitCode = 1;
    return;
  }
  let matches;
  try {
    matches = findRevertMatches(getDb(), regex);
  } catch (err: any) {
    console.error(chalk.red(`Invalid regex: ${err.message}`));
    process.exitCode = 1;
    return;
  }
  if (matches.length === 0) {
    console.log(chalk.dim("No scanned files match that regex."));
    return;
  }
  console.log(
    chalk.bold(
      `revert will delete ${matches.length} file(s) and their journal entries:`,
    ),
  );
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
  const deleted = deleteMatches(
    getDb(),
    matches.map((m) => m.id),
  );
  console.log(
    chalk.green(`✓ Reverted ${deleted} file(s) and all linked records.`),
  );
}
