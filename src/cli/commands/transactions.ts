import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { listJournalLines, type JournalLineRow } from "../../db/queries/journal.js";
import { formatCurrencyAmount } from "../../currency.js";

function fmt(n: number): string {
  return formatCurrencyAmount(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

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

interface EntryGroup {
  entry_id: string;
  date: string;
  description: string;
  lines: JournalLineRow[];
}

function groupByEntry(lines: JournalLineRow[]): EntryGroup[] {
  const groups: EntryGroup[] = [];
  let current: EntryGroup | null = null;
  for (const l of lines) {
    if (!current || current.entry_id !== l.entry_id) {
      current = {
        entry_id: l.entry_id,
        date: l.entry_date ?? "",
        description: l.entry_description ?? "",
        lines: [],
      };
      groups.push(current);
    }
    current.lines.push(l);
  }
  return groups;
}

export function showTransactions(opts: ShowTransactionsOptions): void {
  const db = getDb();
  const lines = listJournalLines(db, {
    account_id: opts.account,
    from: opts.from,
    to: opts.to,
    q: opts.query,
    limit: opts.limit ?? 100,
  });
  if (lines.length === 0) {
    console.log(chalk.yellow("No journal lines match those filters."));
    return;
  }

  const truncatedAccount = new Map<string, string>();
  const truncatedMemo = new Map<string, string>();
  for (const l of lines) {
    const acct = l.account_name ?? l.account_id;
    truncatedAccount.set(l.id, truncateMiddle(acct, ACCOUNT_CAP));
    if (l.memo) truncatedMemo.set(l.id, truncateMiddle(l.memo, MEMO_CAP));
  }

  const accountWidth = Math.max(
    ...lines.map((l) => truncatedAccount.get(l.id)!.length),
  );
  const amountWidth = Math.max(
    ...lines.map((l) => {
      const side = l.debit > 0 ? "DR" : "CR";
      const amt = l.debit > 0 ? l.debit : l.credit;
      return `${side} ${fmt(amt)}`.length;
    }),
  );

  const cols = process.stdout.columns || 100;
  const descMax = Math.max(20, cols - 14);

  const groups = groupByEntry(lines);
  for (const g of groups) {
    const desc = truncateMiddle(g.description, descMax);
    console.log(`${chalk.dim(g.date)}  ${chalk.bold(desc)}`);
    for (const l of g.lines) {
      const acct = truncatedAccount.get(l.id)!;
      const acctPadded = acct + " ".repeat(accountWidth - acct.length);
      const side = l.debit > 0 ? "DR" : "CR";
      const amt = l.debit > 0 ? l.debit : l.credit;
      const rawAmount = `${side} ${fmt(amt)}`;
      const colored = l.debit > 0 ? chalk.cyan(rawAmount) : chalk.magenta(rawAmount);
      const amountPadded =
        " ".repeat(amountWidth - visibleLength(colored)) + colored;
      const memo = truncatedMemo.get(l.id);
      const memoStr = memo ? `    ${chalk.dim(memo)}` : "";
      console.log(`    ${acctPadded}  ${amountPadded}${memoStr}`);
    }
  }

  if (groups.length > 1) {
    console.log("");
    console.log(
      chalk.dim(`  ${groups.length} entries · ${lines.length} lines`),
    );
  }
}
