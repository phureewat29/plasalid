import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { getAccountBalances } from "../../db/queries/account-balance.js";

export async function showAccounts(): Promise<void> {
  const db = getDb();
  const accounts = getAccountBalances(db);
  if (accounts.length === 0) {
    console.log(
      chalk.yellow(
        "No accounts yet. Drop your bank/credit card statements into ~/.plasalid/data/ and run `plasalid scan`.",
      ),
    );
    return;
  }

  const [
    { runBrowser },
    { AccountsBrowser },
    { createElement },
    { listPostings },
  ] = await Promise.all([
    import("../ink/runBrowser.js"),
    import("../ink/AccountsBrowser.js"),
    import("react"),
    import("../../db/queries/transactions.js"),
  ]);
  const recentTransactionsByAccount = new Map<string, ReturnType<typeof listPostings>>();
  for (const a of accounts) {
    const rows = listPostings(db, { account_id: a.id, limit: 10 });
    if (rows.length > 0) recentTransactionsByAccount.set(a.id, rows);
  }
  await runBrowser(createElement(AccountsBrowser, { accounts, recentTransactionsByAccount }));
}
