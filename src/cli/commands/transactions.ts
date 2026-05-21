import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import {
  groupByTransaction,
  listPostings,
  type PostingRow,
  type TransactionGroup,
} from "../../db/queries/transactions.js";
import { visibleLength } from "../format.js";
import { formatAmount } from "../../currency.js";
import { truncateMiddle } from "../helper.js";

const ACCOUNT_CAP = 32;
const MEMO_CAP = 40;
const INTERACTIVE_LIMIT = 1000;
const RECURRING_MARKER = "[R]";

export interface ShowTransactionsOptions {
  account?: string;
  from?: string;
  to?: string;
  query?: string;
  limit?: number;
  /** Force the plain-print path even when stdout is a TTY. */
  noInteractive?: boolean;
}

export async function showTransactions(opts: ShowTransactionsOptions): Promise<void> {
  const db = getDb();
  const interactive = !opts.noInteractive && Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
  const requestedLimit = opts.limit ?? (interactive ? INTERACTIVE_LIMIT : 100);

  const postings = listPostings(db, {
    account_id: opts.account,
    from: opts.from,
    to: opts.to,
    q: opts.query,
    limit: requestedLimit,
  });

  if (postings.length === 0) {
    console.log(chalk.yellow("No postings match those filters."));
    return;
  }

  if (interactive) {
    const filterSummary = buildFilterSummary(opts);
    const [{ runBrowser }, { TransactionsBrowser }, { createElement }] = await Promise.all([
      import("../ink/runBrowser.js"),
      import("../ink/TransactionsBrowser.js"),
      import("react"),
    ]);
    await runBrowser(createElement(TransactionsBrowser, { postings, filterSummary }));
    return;
  }

  printTransactionsPlain(postings);
}

function buildFilterSummary(opts: ShowTransactionsOptions): string {
  const parts: string[] = [];
  if (opts.account) parts.push(`account=${opts.account}`);
  if (opts.from)    parts.push(`from=${opts.from}`);
  if (opts.to)      parts.push(`to=${opts.to}`);
  if (opts.query)   parts.push(`query="${opts.query}"`);
  return parts.join(" · ");
}

function printTransactionsPlain(postings: PostingRow[]): void {
  const truncatedAccount = new Map<string, string>();
  const truncatedMemo = new Map<string, string>();
  for (const p of postings) {
    const acct = p.account_name ?? p.account_id;
    truncatedAccount.set(p.id, truncateMiddle(acct, ACCOUNT_CAP));
    if (p.memo) truncatedMemo.set(p.id, truncateMiddle(p.memo, MEMO_CAP));
  }

  const accountWidth = Math.max(
    ...postings.map((p) => truncatedAccount.get(p.id)!.length),
  );
  const amountWidth = Math.max(
    ...postings.map((p) => {
      const side = p.debit > 0 ? "DR" : "CR";
      const amt = p.debit > 0 ? p.debit : p.credit;
      return `${side} ${formatAmount(amt, p.currency)}`.length;
    }),
  );

  const cols = process.stdout.columns || 100;
  const descMax = Math.max(20, cols - 14);

  const groups: TransactionGroup[] = groupByTransaction(postings);
  for (const g of groups) {
    const desc = truncateMiddle(g.description, descMax);
    const merchant = g.merchant ? chalk.green(`  · ${g.merchant}`) : "";
    const recurring = g.recurrence_id ? chalk.dim(`  ${RECURRING_MARKER}`) : "";
    console.log(`${chalk.dim(g.date)}  ${chalk.bold(desc)}${merchant}${recurring}`);
    for (const p of g.postings) {
      const acct = truncatedAccount.get(p.id)!;
      const acctPadded = acct + " ".repeat(accountWidth - acct.length);
      const side = p.debit > 0 ? "DR" : "CR";
      const amt = p.debit > 0 ? p.debit : p.credit;
      const rawAmount = `${side} ${formatAmount(amt, p.currency)}`;
      const colored = p.debit > 0 ? chalk.cyan(rawAmount) : chalk.magenta(rawAmount);
      const amountPadded =
        " ".repeat(amountWidth - visibleLength(colored)) + colored;
      const memo = truncatedMemo.get(p.id);
      const memoStr = memo ? `    ${chalk.dim(memo)}` : "";
      console.log(`    ${acctPadded}  ${amountPadded}${memoStr}`);
    }
  }

  if (groups.length > 1) {
    console.log("");
    console.log(
      chalk.dim(`  ${groups.length} transactions · ${postings.length} postings`),
    );
  }
}
