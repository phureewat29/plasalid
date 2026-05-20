import chalk from "chalk";
import { runResolve, type ResolveOptions } from "../../resolver/pipeline.js";

export async function runResolveCommand(opts: ResolveOptions): Promise<void> {
  try {
    const summary = await runResolve(opts);
    console.log("");
    console.log(chalk.bold(summary));
  } catch (err: any) {
    console.error(chalk.red(`Resolve failed: ${err.message}`));
    process.exitCode = 1;
  }
}
