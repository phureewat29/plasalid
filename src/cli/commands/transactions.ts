import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { listPostings, type PostingRow } from "../../db/queries/transactions.js";
import { visibleLength } from "../format.js";
import { formatAmount } from "../../currency.js";

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max < 5) return s.slice(0, max);
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

const ACCOUNT_CAP = 32;
const MEMO_CAP = 40;

export interface ShowTransactionsOptions {
  account?: string;
  from?: string;
  to?: string;
  query?: string;
  limit?: number;
}

interface TransactionGroup {
  transaction_id: string;
  date: string;
  description: string;
  merchant: string | null;
  postings: PostingRow[];
}

function groupByTransaction(postings: PostingRow[]): TransactionGroup[] {
  const groups: TransactionGroup[] = [];
  let current: TransactionGroup | null = null;
  for (const p of postings) {
    if (!current || current.transaction_id !== p.transaction_id) {
      current = {
        transaction_id: p.transaction_id,
        date: p.transaction_date ?? "",
        description: p.transaction_description ?? "",
        merchant: p.merchant_name ?? null,
        postings: [],
      };
      groups.push(current);
    }
    current.postings.push(p);
  }
  return groups;
}

export function showTransactions(opts: ShowTransactionsOptions): void {
  const db = getDb();
  const postings = listPostings(db, {
    account_id: opts.account,
    from: opts.from,
    to: opts.to,
    q: opts.query,
    limit: opts.limit ?? 100,
  });
  if (postings.length === 0) {
    console.log(chalk.yellow("No postings match those filters."));
    return;
  }

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
      return `${side} ${formatAmount(amt)}`.length;
    }),
  );

  const cols = process.stdout.columns || 100;
  const descMax = Math.max(20, cols - 14);

  const groups = groupByTransaction(postings);
  for (const g of groups) {
    const desc = truncateMiddle(g.description, descMax);
    const merchant = g.merchant ? chalk.green(`  · ${g.merchant}`) : "";
    console.log(`${chalk.dim(g.date)}  ${chalk.bold(desc)}${merchant}`);
    for (const p of g.postings) {
      const acct = truncatedAccount.get(p.id)!;
      const acctPadded = acct + " ".repeat(accountWidth - acct.length);
      const side = p.debit > 0 ? "DR" : "CR";
      const amt = p.debit > 0 ? p.debit : p.credit;
      const rawAmount = `${side} ${formatAmount(amt)}`;
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
