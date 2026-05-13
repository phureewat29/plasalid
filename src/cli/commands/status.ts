import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { getNetWorth, getPeriodTotals } from "../../db/queries/account_balance.js";
import { formatCurrencyAmount } from "../../currency.js";

function fmt(n: number): string {
  return formatCurrencyAmount(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function showStatus(): void {
  const db = getDb();
  const nw = getNetWorth(db);
  console.log(chalk.bold("Net worth: ") + fmt(nw.net_worth));
  console.log(chalk.dim(`Assets ${fmt(nw.assets)} − Liabilities ${fmt(nw.liabilities)}`));

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const totals = getPeriodTotals(db, monthStart, today);
  console.log("");
  console.log(chalk.bold(`This month (${monthStart} → ${today})`));
  console.log(`  Income: ${fmt(totals.income)}`);
  console.log(`  Expenses: ${fmt(totals.expenses)}`);
  console.log(`  Net: ${fmt(totals.income - totals.expenses)}`);
}
