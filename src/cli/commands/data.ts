import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import chalk from "chalk";
import { getDataDir } from "../../config.js";

function openerCommand(): string | null {
  switch (process.platform) {
    case "darwin": return "open";
    case "win32":  return "explorer";
    case "linux":  return "xdg-open";
    default:       return null;
  }
}

export function runDataCommand(): void {
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  console.log(chalk.dim(`Data folder: ${dataDir}`));

  const cmd = openerCommand();
  if (!cmd) {
    console.log(
      chalk.yellow(
        `Don't know how to open the file manager on ${process.platform}. Open it manually with the path above.`,
      ),
    );
    return;
  }
  const child = spawn(cmd, [dataDir], { stdio: "ignore", detached: true });
  child.on("error", (err: Error) => {
    console.error(chalk.red(`Couldn't open the folder: ${err.message}`));
  });
  child.unref();
}
