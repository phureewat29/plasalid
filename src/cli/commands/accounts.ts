import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { getAccountBalances } from "../../db/queries/account_balance.js";
import { formatCurrencyAmount } from "../../currency.js";
import type {
  AccountBalance,
  AccountType,
} from "../../db/queries/account_balance.js";

function fmtSigned(n: number): string {
  const body = formatCurrencyAmount(n, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `-${body}` : body;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

const TYPE_TAG: Record<AccountType, string> = {
  asset: "asset",
  liability: "liab",
  income: "income",
  expense: "expense",
  equity: "equity",
};
const TYPE_TAG_WIDTH = 8;

const TYPE_RANK: Record<AccountType, number> = {
  asset: 0,
  liability: 1,
  income: 2,
  expense: 3,
  equity: 4,
};

function compactMeta(a: AccountBalance): string[] {
  const meta: string[] = [];
  if (a.bank_name) meta.push(a.bank_name);
  if (a.due_day) meta.push(`due ${a.due_day}`);
  if (a.statement_day) meta.push(`stmt ${a.statement_day}`);
  if (a.points_balance) meta.push(`${a.points_balance.toLocaleString()} pts`);
  if (a.currency && a.currency !== "THB") meta.push(a.currency);
  // Subtype only when there's no other signal yet (e.g. "cash", "salary").
  if (meta.length === 0 && a.subtype) meta.push(a.subtype);
  return meta;
}

export function showAccounts(): void {
  const db = getDb();
  const accounts = [...getAccountBalances(db)].sort((a, b) => {
    const t = TYPE_RANK[a.type] - TYPE_RANK[b.type];
    return t !== 0 ? t : a.name.localeCompare(b.name);
  });
  if (accounts.length === 0) {
    console.log(
      chalk.yellow(
        "No accounts yet. Drop your bank/credit card statements into ~/.plasalid/data/ and run `plasalid scan`.",
      ),
    );
    return;
  }

  const balanceWidth = Math.max(
    ...accounts.map((a) => fmtSigned(a.balance).length),
  );
  const nameWidth = Math.max(...accounts.map((a) => a.name.length));

  for (const a of accounts) {
    const tag = chalk.dim(TYPE_TAG[a.type].padEnd(TYPE_TAG_WIDTH));
    const name = chalk.bold(a.name) + " ".repeat(nameWidth - a.name.length);
    const rawBalance = fmtSigned(a.balance);
    const coloredBalance = a.balance < 0 ? chalk.red(rawBalance) : rawBalance;
    const paddedBalance =
      " ".repeat(balanceWidth - visibleLength(coloredBalance)) + coloredBalance;
    const meta = compactMeta(a);
    const metaStr = meta.length ? `   ${chalk.dim(meta.join(" · "))}` : "";
    console.log(`  ${tag}  ${name}   ${paddedBalance}${metaStr}`);
  }

  let assets = 0,
    liabilities = 0;
  for (const a of accounts) {
    if (a.type === "asset") assets += a.balance;
    else if (a.type === "liability") liabilities += a.balance;
  }
  const netWorth = assets - liabilities;
  console.log("");
  console.log(
    "  " +
      chalk.dim(`Assets ${fmtSigned(assets)}`) +
      chalk.dim("   ·   ") +
      chalk.dim(`Liabilities ${fmtSigned(liabilities)}`) +
      chalk.dim("   ·   ") +
      chalk.bold(`Net worth ${fmtSigned(netWorth)}`),
  );
}
