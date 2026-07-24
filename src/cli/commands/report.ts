import type { Command } from "commander";
import { padLabel } from "../format.js";
import { currentMode, emit, fail, runAction, type OutputMode } from "../output.js";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Print a flat set of key/value pairs: colored two-column in TTY, tab-separated otherwise. */
function printKeyValues(mode: OutputMode, rows: [string, string | number][]): void {
  if (!mode.tty) {
    process.stdout.write(rows.map(([k, v]) => `${k}\t${v}`).join("\n") + "\n");
    return;
  }
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) {
    process.stdout.write(`${padLabel(k, width, { bold: mode.color })}  ${v}\n`);
  }
}

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
        printKeyValues(mode, [
          ["from", result.from],
          ["to", result.to],
          ["income", result.income],
          ["expenses", result.expenses],
          ["net", result.net],
        ]);
      }),
    );
}
