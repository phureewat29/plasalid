import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import {
  getNetWorth,
  getPeriodTotals,
} from "../../db/queries/account-balance.js";
import { formatAmount } from "../../currency.js";

export function showStatus(): void {
  const db = getDb();
  const nw = getNetWorth(db);
  console.log(chalk.bold("Net worth: ") + formatAmount(nw.net_worth));
  console.log(
    chalk.dim(
      `Assets ${formatAmount(nw.assets)} − Liabilities ${formatAmount(nw.liabilities)}`,
    ),
  );

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const totals = getPeriodTotals(db, monthStart, today);
  console.log("");
  console.log(chalk.bold(`This month (${monthStart} → ${today})`));
  console.log(`  Income: ${formatAmount(totals.income)}`);
  console.log(`  Expenses: ${formatAmount(totals.expenses)}`);
  console.log(`  Net: ${formatAmount(totals.income - totals.expenses)}`);
}
