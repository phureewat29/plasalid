import chalk from "chalk";
import { getActiveModel } from "../../../config.js";

export function useFooterText(): string {
  const model = getActiveModel();
  return [
    chalk.cyan("<°(((><"),
    chalk.dim(model),
    chalk.dim("ctrl+c to exit"),
  ].join(chalk.dim("  |  "));
}
