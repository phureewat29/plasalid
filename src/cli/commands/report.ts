import type { Command } from "commander";
import { printKeyValues } from "../format.js";
import { currentMode, emit, fail, runAction } from "../output.js";
import { ISO_DATE_RE } from "../../lib/date.js";

export function registerReport(program: Command): void {
  program
    .command("report")
    .description("Income / expenses / net over a date range (net worth: plasalid status)")
    .option("--from <date>", "start date")
    .option("--to <date>", "end date")
    .action(
      runAction(async (opts: any) => {
        if (!opts.from || !opts.to) fail("USAGE", "--from and --to are required");
        if (!ISO_DATE_RE.test(opts.from)) {
          fail("USAGE", `--from must be an ISO date (YYYY-MM-DD), got "${opts.from}"`);
        }
        if (!ISO_DATE_RE.test(opts.to)) {
          fail("USAGE", `--to must be an ISO date (YYYY-MM-DD), got "${opts.to}"`);
        }

        const { getDb } = await import("../../db/connection.js");
        const { getPeriodTotalsFromTransactions } = await import("../../accounts/balances.js");
        const db = getDb();
        const totals = getPeriodTotalsFromTransactions(db, opts.from, opts.to);
        const result = {
          from: opts.from as string,
          to: opts.to as string,
          income: totals.income,
          expenses: totals.expenses,
          net: totals.income - totals.expenses,
        };
        const mode = currentMode();
        if (mode.json) {
          emit(result);
          return;
        }
        printKeyValues(
          mode,
          [
            ["from", result.from],
            ["to", result.to],
            ["income", result.income],
            ["expenses", result.expenses],
            ["net", result.net],
          ],
          { bold: mode.color },
        );
      }),
    );
}
