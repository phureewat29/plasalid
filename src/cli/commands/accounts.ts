import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { getAccountBalances } from "../../db/queries/account-balance.js";
import { visibleLength } from "../format.js";
import { formatSignedAmount } from "../../currency.js";
import type {
  AccountBalance,
  AccountType,
} from "../../db/queries/account-balance.js";

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
  const raw = getAccountBalances(db);
  if (raw.length === 0) {
    console.log(
      chalk.yellow(
        "No accounts yet. Drop your bank/credit card statements into ~/.plasalid/data/ and run `plasalid scan`.",
      ),
    );
    return;
  }

  const byId = new Map(raw.map((a) => [a.id, a]));
  const depthCache = new Map<string, number>();
  const depthOf = (id: string): number => {
    if (depthCache.has(id)) return depthCache.get(id)!;
    const node = byId.get(id);
    if (!node || !node.parent_id) {
      depthCache.set(id, 0);
      return 0;
    }
    const d = depthOf(node.parent_id) + 1;
    depthCache.set(id, d);
    return d;
  };

  const accounts = [...raw].sort((a, b) => {
    const t = TYPE_RANK[a.type] - TYPE_RANK[b.type];
    if (t !== 0) return t;
    return a.id.localeCompare(b.id);
  });

  const balanceWidth = Math.max(
    ...accounts.map((a) => formatSignedAmount(a.balance).length),
  );
  const nameWidth = Math.max(
    ...accounts.map((a) => a.name.length + depthOf(a.id) * 2),
  );

  for (const a of accounts) {
    const tag = chalk.dim(TYPE_TAG[a.type].padEnd(TYPE_TAG_WIDTH));
    const indent = "  ".repeat(depthOf(a.id));
    const displayName = indent + a.name;
    const name =
      chalk.bold(displayName) + " ".repeat(nameWidth - displayName.length);
    const rawBalance = formatSignedAmount(a.balance);
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
      chalk.dim(`Assets ${formatSignedAmount(assets)}`) +
      chalk.dim("   ·   ") +
      chalk.dim(`Liabilities ${formatSignedAmount(liabilities)}`) +
      chalk.dim("   ·   ") +
      chalk.bold(`Net worth ${formatSignedAmount(netWorth)}`),
  );
}
