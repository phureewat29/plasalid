import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import chalk from "chalk";
import { getDataDir } from "../../config.js";
import { currentMode, emit } from "../output.js";

function openerCommand(): string | null {
  switch (process.platform) {
    case "darwin": return "open";
    case "win32":  return "explorer";
    case "linux":  return "xdg-open";
    default:       return null;
  }
}

/**
 * Spawn the OS file-manager opener, detached. Resolves with an error message
 * when the spawn itself failed (e.g. ENOENT for a missing opener binary) or
 * undefined on success. Never rejects — a failed opener is not fatal, it just
 * gets surfaced as `spawn_error` alongside the path.
 */
function spawnOpener(cmd: string, dataDir: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, [dataDir], { stdio: "ignore", detached: true });
    child.once("error", (err: Error) => resolvePromise(err.message));
    child.once("spawn", () => resolvePromise(undefined));
    child.unref();
  });
}

/**
 * Open the Plasalid data folder in the OS file explorer. Honors the --json
 * contract: `{"path": <dataDir>}` (plus `spawn_error` when the opener failed
 * to launch) under --json, a bare path line when piped, and the original
 * human-friendly TTY output otherwise. A missing/failed opener is reported,
 * never thrown — the data dir still exists and its path is still useful.
 */
export async function runDataCommand(): Promise<void> {
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const cmd = openerCommand();
  const spawnError = cmd
    ? await spawnOpener(cmd, dataDir)
    : `don't know how to open the file manager on ${process.platform}`;

  const mode = currentMode();
  if (mode.json) {
    const result: { path: string; spawn_error?: string } = { path: dataDir };
    if (spawnError) result.spawn_error = spawnError;
    emit(result);
    return;
  }

  if (!mode.tty) {
    process.stdout.write(dataDir + "\n");
    return;
  }

  console.log(chalk.dim(`Data folder: ${dataDir}`));
  if (spawnError) {
    console.log(
      chalk.yellow(`Couldn't open the folder automatically: ${spawnError}. Open it manually with the path above.`),
    );
  }
}
