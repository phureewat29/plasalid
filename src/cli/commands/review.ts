import chalk from "chalk";
import { runReview, type ReviewOptions } from "../../reviewer/pipeline.js";

export async function runReviewCommand(opts: ReviewOptions): Promise<void> {
  try {
    const result = await runReview(opts);
    if (result.summary) {
      console.log("");
      console.log(chalk.bold(result.summary));
    }
  } catch (err: any) {
    console.error(chalk.red(`Review failed: ${err.message}`));
    process.exitCode = 1;
  }
}
