import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { listPostings } from "../../db/queries/transactions.js";

const DEFAULT_LIMIT = 1000;

export interface ShowTransactionsOptions {
  account?: string;
  from?: string;
  to?: string;
  query?: string;
  limit?: number;
}

export async function showTransactions(opts: ShowTransactionsOptions): Promise<void> {
  const db = getDb();
  const postings = listPostings(db, {
    account_id: opts.account,
    from: opts.from,
    to: opts.to,
    q: opts.query,
    limit: opts.limit ?? DEFAULT_LIMIT,
  });

  if (postings.length === 0) {
    console.log(chalk.yellow("No postings match those filters."));
    return;
  }

  const filterSummary = buildFilterSummary(opts);
  const [{ runBrowser }, { TransactionsBrowser }, { createElement }] = await Promise.all([
    import("../ink/runBrowser.js"),
    import("../ink/TransactionsBrowser.js"),
    import("react"),
  ]);
  await runBrowser(createElement(TransactionsBrowser, { postings, filterSummary }));
}

function buildFilterSummary(opts: ShowTransactionsOptions): string {
  const parts: string[] = [];
  if (opts.account) parts.push(`account=${opts.account}`);
  if (opts.from)    parts.push(`from=${opts.from}`);
  if (opts.to)      parts.push(`to=${opts.to}`);
  if (opts.query)   parts.push(`query="${opts.query}"`);
  return parts.join(" · ");
}
