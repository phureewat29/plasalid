import chalk from "chalk";
import { runReconcile, type ReconcileOptions } from "../../reconciler/pipeline.js";

export async function runReconcileCommand(opts: ReconcileOptions): Promise<void> {
  try {
    const result = await runReconcile(opts);
    if (result.summary) {
      console.log("");
      console.log(chalk.bold(result.summary));
    }
  } catch (err: any) {
    console.error(chalk.red(`Reconcile failed: ${err.message}`));
    process.exitCode = 1;
  }
}
