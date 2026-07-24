import type Database from "libsql";
import { insertTransaction } from "../db/queries/transactions.js";
import { config } from "../config.js";
import { fromMinorUnits, toMinorUnits } from "../lib/money.js";
import { todayIso, ISO_DATE_RE } from "../lib/date.js";
import {
  type AccountType,
  type AccountRow,
  type AccountBalanceMinor,
} from "./types.js";
import {
  findAccountById,
  ensureStructuralAccount,
  getAccountSubtree,
} from "./accounts.js";

interface NetWorth {
  assets: number;
  liabilities: number;
  net_worth: number;
}

interface PeriodTotals {
  income: number;
  expenses: number;
}

// Balance derivations below share one normal-balance rule: asset/expense are
// debit-normal, the rest credit-normal. Amounts are integer minor units;
// decimal fields are derived per the account's own currency exponent.

/** Debit + credit legs of every non-void transaction, one row per leg (`void_of`
 *  rows excluded so a merged mirror never double-counts). */
const TRANSACTION_LEGS = `SELECT debit_account_id  AS acct, amount, date, 'D' AS side FROM transactions WHERE void_of IS NULL
       UNION ALL
       SELECT credit_account_id AS acct, amount, date, 'C' AS side FROM transactions WHERE void_of IS NULL`;

/** Per-account balance from the `transactions` table (normal-balance rule above). */
export function getAccountBalancesFromTransactions(
  db: Database.Database,
  opts: { type?: AccountType; idOrParent?: string } = {},
): AccountBalanceMinor[] {
  const params: any[] = [];
  const where: string[] = [];
  if (opts.type) {
    where.push("a.type = ?");
    params.push(opts.type);
  }
  if (opts.idOrParent) {
    where.push("(a.id = ? OR a.parent_id = ?)");
    params.push(opts.idOrParent, opts.idOrParent);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT a.*,
              COALESCE(SUM(CASE WHEN t.side = 'D' THEN t.amount ELSE 0 END), 0) AS sum_debit,
              COALESCE(SUM(CASE WHEN t.side = 'C' THEN t.amount ELSE 0 END), 0) AS sum_credit
         FROM accounts a
         LEFT JOIN (${TRANSACTION_LEGS}) t ON t.acct = a.id
         ${whereSql}
         GROUP BY a.id
         ORDER BY a.type, a.id`,
    )
    .all(...params) as (AccountRow & { sum_debit: number; sum_credit: number })[];

  return rows.map((r) => {
    const debitNormal = r.type === "asset" || r.type === "expense";
    const balance_minor = debitNormal ? r.sum_debit - r.sum_credit : r.sum_credit - r.sum_debit;
    const { sum_debit, sum_credit, ...account } = r;
    return {
      ...(account as AccountRow),
      debits_posted: sum_debit,
      credits_posted: sum_credit,
      balance_minor,
      balance: fromMinorUnits(balance_minor, account.currency),
    };
  });
}

export function getNetWorthFromTransactions(db: Database.Database): NetWorth {
  const balances = getAccountBalancesFromTransactions(db);
  let assets = 0;
  let liabilities = 0;
  for (const b of balances) {
    if (b.type === "asset") assets += b.balance;
    else if (b.type === "liability") liabilities += b.balance;
  }
  return { assets, liabilities, net_worth: assets - liabilities };
}

/**
 * Income (credits − debits) and expenses (debits − credits) over a date range.
 * Grouped by (type, currency) so each currency converts with its own exponent.
 */
export function getPeriodTotalsFromTransactions(
  db: Database.Database,
  from: string,
  to: string,
): PeriodTotals {
  const rows = db
    .prepare(
      `SELECT a.type AS type, a.currency AS currency,
              SUM(CASE WHEN t.side = 'C' THEN t.amount ELSE -t.amount END) AS c_minus_d
         FROM (${TRANSACTION_LEGS}) t
         JOIN accounts a ON a.id = t.acct
         WHERE t.date BETWEEN ? AND ? AND a.type IN ('income', 'expense')
         GROUP BY a.type, a.currency`,
    )
    .all(from, to) as { type: AccountType; currency: string; c_minus_d: number }[];

  let income = 0;
  let expenses = 0;
  for (const r of rows) {
    if (r.type === "income") income += fromMinorUnits(r.c_minus_d, r.currency);
    else if (r.type === "expense") expenses += fromMinorUnits(-r.c_minus_d, r.currency);
  }
  return { income, expenses };
}

/** Subtree balance (root inclusive), grouped by (type, currency) for correct conversion. */
export function getRollupBalanceFromTransactions(db: Database.Database, rootId: string): number {
  const subtree = getAccountSubtree(db, rootId);
  if (subtree.length === 0) return 0;
  const ids = subtree.map((a) => a.id);
  const placeholders = ids.map(() => "?").join(",");

  const rows = db
    .prepare(
      `SELECT a.type AS type, a.currency AS currency,
              COALESCE(SUM(CASE WHEN t.side = 'D' THEN t.amount ELSE 0 END), 0) AS sum_debit,
              COALESCE(SUM(CASE WHEN t.side = 'C' THEN t.amount ELSE 0 END), 0) AS sum_credit
         FROM accounts a
         LEFT JOIN (${TRANSACTION_LEGS}) t ON t.acct = a.id
         WHERE a.id IN (${placeholders})
         GROUP BY a.type, a.currency`,
    )
    .all(...ids) as { type: AccountType; currency: string; sum_debit: number; sum_credit: number }[];

  let total = 0;
  for (const r of rows) {
    const debitNormal = r.type === "asset" || r.type === "expense";
    const minor = debitNormal ? r.sum_debit - r.sum_credit : r.sum_credit - r.sum_debit;
    total += fromMinorUnits(minor, r.currency);
  }
  return total;
}

const EQUITY_ADJUST_ID = "equity:adjustments";

interface AdjustViaTransactionOpts {
  accountId: string;
  /** New desired balance in the account's currency, decimal, natural sign. */
  targetAmount: number;
  reason: string;
  /** ISO YYYY-MM-DD. Defaults to today. */
  date?: string;
}

interface AdjustViaTransactionResult {
  /** Id of the balancing transaction, or null when already at target (no-op). */
  transactionId: string | null;
  /** target − current, decimal, natural sign. 0 on no-op. */
  delta: number;
}

/**
 * Moves an account to `targetAmount` by posting one balancing transaction
 * against `equity:adjustments`. Delta math is integer minor units (no float
 * drift); a zero delta is a no-op.
 */
export function adjustAccountBalanceViaTransaction(
  db: Database.Database,
  opts: AdjustViaTransactionOpts,
): AdjustViaTransactionResult {
  const account = findAccountById(db, opts.accountId);
  if (!account) throw new Error(`Account "${opts.accountId}" not found.`);

  const target = Number(opts.targetAmount);
  if (!Number.isFinite(target)) {
    throw new Error(`targetAmount must be a number, got ${JSON.stringify(opts.targetAmount)}.`);
  }

  const currency = account.currency || config.displayCurrency;
  const currentMinor =
    getAccountBalancesFromTransactions(db, { idOrParent: account.id }).find((b) => b.id === account.id)
      ?.balance_minor ?? 0;
  const targetMinor = toMinorUnits(target, currency);
  const deltaMinor = targetMinor - currentMinor;
  if (deltaMinor === 0) return { transactionId: null, delta: 0 };

  const amount = Math.abs(deltaMinor);
  const debitNormal = account.type === "asset" || account.type === "expense";
  const accountIsDebit = (debitNormal && deltaMinor > 0) || (!debitNormal && deltaMinor < 0);
  const debitAccountId = accountIsDebit ? account.id : EQUITY_ADJUST_ID;
  const creditAccountId = accountIsDebit ? EQUITY_ADJUST_ID : account.id;

  const date =
    opts.date && ISO_DATE_RE.test(opts.date) ? opts.date : todayIso();
  const reason = String(opts.reason || "Balance adjustment").trim();

  let transactionId = "";
  const tx = db.transaction((): void => {
    if (!findAccountById(db, EQUITY_ADJUST_ID)) {
      ensureStructuralAccount(db, "equity:adjustments");
    }
    transactionId = insertTransaction(db, {
      date,
      description: reason,
      debit_account_id: debitAccountId,
      credit_account_id: creditAccountId,
      amount,
      currency,
    }).id;
  });
  tx();

  return { transactionId, delta: fromMinorUnits(deltaMinor, currency) };
}
