import type { Command } from "commander";
import { randomUUID } from "crypto";
import { getDb } from "../../db/connection.js";
import { emit, fail, readStdinToEnd, requireYes, runAction } from "../output.js";
import {
  insertTransaction,
  deleteTransaction,
  updateTransactionMeta,
  bulkRecategorize,
  type BulkRecategorizeFilter,
  type UpdateTransactionMetaFields,
} from "../../db/queries/transactions.js";
import { findAccountById } from "../../db/queries/account-balance.js";
import {
  commitTransaction,
  defaultTransactionCommitHooks,
  type TransactionCommitContext,
  type RawTransactionInput,
} from "../../scanner/commit-transaction.js";
import { toMinorUnits } from "../../currency.js";

/**
 * `transactions` — the write command for the transaction ledger. `transactions add`
 * creates a transaction (strict by default: both accounts must already exist;
 * `--resolve` fuzzy-resolves account/merchant hints and raises questions).
 * Remaining subcommands cover bulk recategorize, metadata edits, and deletion.
 */

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface AddTransactionOpts {
  resolve?: boolean;
  debitAccount?: string;
  creditAccount?: string;
  amount?: string;
  date?: string;
  description?: string;
  merchantName?: string;
}

/** Build a raw (decimal-amount) transaction from convenience flags or a JSON object
 *  on stdin. Does not validate accounts — the create path does that. */
async function buildRawTransaction(opts: AddTransactionOpts): Promise<RawTransactionInput> {
  const anyFlag =
    opts.debitAccount !== undefined || opts.creditAccount !== undefined || opts.amount !== undefined;

  if (anyFlag) {
    const missing: string[] = [];
    if (!opts.debitAccount) missing.push("--debit-account");
    if (!opts.creditAccount) missing.push("--credit-account");
    if (opts.amount === undefined) missing.push("--amount");
    if (missing.length) fail("USAGE", `transactions add requires ${missing.join(", ")}`);

    const amount = Number(opts.amount);
    if (!Number.isFinite(amount)) fail("USAGE", `--amount must be a number, got "${opts.amount}"`);

    const raw: RawTransactionInput = {
      date: opts.date ?? todayIso(),
      description: opts.description ?? opts.merchantName ?? "Manual entry",
      debit_account_id: opts.debitAccount!,
      credit_account_id: opts.creditAccount!,
      amount,
      currency: null,
    };
    if (opts.merchantName) raw.merchant = { canonical_name: opts.merchantName };
    return raw;
  }

  const stdin = await readStdinToEnd();
  if (!stdin.trim()) {
    fail(
      "USAGE",
      "provide --debit-account/--credit-account/--amount, or pipe a transaction JSON object on stdin",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch (err) {
    fail("USAGE", `invalid JSON on stdin: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("USAGE", "stdin must contain a single JSON transaction object (not an array)");
  }
  const obj = parsed as any;
  return {
    date: obj.date,
    description: obj.description ?? obj.merchant?.canonical_name ?? "Manual entry",
    debit_account_id: obj.debit_account_id ?? obj.debit_account,
    credit_account_id: obj.credit_account_id ?? obj.credit_account,
    amount: obj.amount,
    currency: obj.currency ?? null,
    merchant: obj.merchant ?? null,
    merchant_id: obj.merchant_id ?? null,
    raw_descriptor: obj.raw_descriptor ?? null,
    source_page: obj.source_page ?? null,
    code: obj.code ?? null,
  };
}

async function addTransaction(opts: AddTransactionOpts): Promise<void> {
  const db = getDb();
  const raw = await buildRawTransaction(opts);

  if (opts.resolve) {
    const scanId = `sc:${randomUUID()}`;
    const ctx: TransactionCommitContext = {
      scanId,
      fileId: null,
      fileHash: null,
      chunkId: null,
      progress: null,
    };
    const outcome = commitTransaction(db, ctx, raw, defaultTransactionCommitHooks(db, ctx));
    if (!outcome.ok) {
      if (outcome.reason === "currency_mismatch") {
        fail("INVALID", outcome.message, {
          hint: "add a linked conversion pair (one leg per currency, sharing a group)",
        });
      }
      fail("INVALID", outcome.message);
    }
    emit({
      transaction_id: outcome.transactionId,
      duplicate: outcome.duplicate,
      raised_questions: outcome.raisedQuestions,
      currency_overridden: outcome.currencyOverridden,
    });
    return;
  }

  // Strict path: both accounts must already exist.
  if (!raw.debit_account_id || !raw.credit_account_id) {
    fail("USAGE", "debit_account_id and credit_account_id are required");
  }
  if (typeof raw.amount !== "number" || !Number.isFinite(raw.amount)) {
    fail("USAGE", "amount must be a number");
  }

  const accountHint =
    "create it with `plasalid accounts create`, or find a close match with `plasalid accounts match --query <name>`, or re-run with --resolve";
  const debit = findAccountById(db, raw.debit_account_id);
  if (!debit) fail("NOT_FOUND", `account "${raw.debit_account_id}" not found`, { hint: accountHint });
  const credit = findAccountById(db, raw.credit_account_id);
  if (!credit) fail("NOT_FOUND", `account "${raw.credit_account_id}" not found`, { hint: accountHint });

  // Currency is derived from the resolved accounts; a cross-currency transaction is
  // rejected (add it as a linked conversion pair instead).
  const currency = debit.currency || "THB";
  if ((credit.currency || "THB") !== currency) {
    fail(
      "INVALID",
      `debit ${debit.id} is ${currency}, credit ${credit.id} is ${credit.currency}; a single transaction can't cross currencies`,
      { hint: "add a linked conversion pair (one leg per currency, sharing a group)" },
    );
  }

  let result: { id: string; duplicate: boolean };
  try {
    result = insertTransaction(db, {
      date: raw.date,
      description: raw.description,
      debit_account_id: raw.debit_account_id,
      credit_account_id: raw.credit_account_id,
      amount: toMinorUnits(raw.amount, currency),
      currency,
      merchant: raw.merchant ?? null,
      merchant_id: raw.merchant_id ?? null,
      raw_descriptor: raw.raw_descriptor ?? null,
      source_page: raw.source_page ?? null,
      code: raw.code ?? null,
    });
  } catch (err) {
    fail("INVALID", (err as Error).message);
  }
  emit({ transaction_id: result.id, duplicate: result.duplicate });
}

export function registerTransactions(program: Command): void {
  const transactions = program
    .command("transactions")
    .description("Write transactions: add / update / delete / recategorize");

  transactions
    .command("add")
    .description("Add a manual transaction; statement rows belong in `ingest commit`")
    .option("--resolve", "fuzzy-resolve account/merchant hints and raise questions instead of failing")
    .option("--debit-account <id>", "debit account id")
    .option("--credit-account <id>", "credit account id")
    .option("--amount <n>", "transaction amount (decimal)")
    .option("--date <date>", "transaction date (defaults to today)")
    .option("--description <text>", "transaction description")
    .option("--merchant-name <name>", "merchant name to upsert and link")
    .action(runAction((opts: AddTransactionOpts) => addTransaction(opts)));

  transactions
    .command("recategorize")
    .description("Bulk re-point one account's transactions onto another")
    .option("--set-account <id>", "account id to move matching transactions to")
    .option("--filter-account <id>", "account whose transactions are moved (required)")
    .action(
      runAction(
        (opts: { setAccount?: string; filterAccount?: string }) => {
          if (!opts.setAccount) fail("USAGE", "--set-account is required");
          if (!opts.filterAccount) {
            fail("USAGE", "--filter-account is required (recategorize moves that account's transactions)");
          }
          const db = getDb();
          const filter: BulkRecategorizeFilter = { accountId: opts.filterAccount };

          let result;
          try {
            result = bulkRecategorize(db, filter, { accountId: opts.setAccount });
          } catch (err) {
            fail("INVALID", (err as Error).message);
          }
          emit({
            affected: result.affected,
            skipped_self_transaction: result.skipped_self_transaction,
            sample_transaction_ids: result.sample_transaction_ids,
          });
        },
      ),
    );

  transactions
    .command("update <id>")
    .description("Update a transaction's metadata")
    .option("--date <date>", "transaction date")
    .option("--description <text>", "transaction description")
    .option("--merchant <id>", "merchant id to set")
    .action(
      runAction(
        (
          id: string,
          opts: { date?: string; description?: string; merchant?: string },
        ) => {
          const fields: UpdateTransactionMetaFields = {};
          if (opts.date !== undefined) fields.date = opts.date;
          if (opts.description !== undefined) fields.description = opts.description;
          if (opts.merchant !== undefined) fields.merchant_id = opts.merchant;
          if (Object.keys(fields).length === 0) {
            fail("USAGE", "at least one of --date, --description, --merchant is required");
          }
          const db = getDb();
          const changes = updateTransactionMeta(db, id, fields);
          if (changes === 0) fail("NOT_FOUND", `transaction "${id}" not found`);
          emit({ transaction_id: id, updated: true });
        },
      ),
    );

  transactions
    .command("delete <id>")
    .description("Delete a transaction")
    .option("--yes", "skip confirmation")
    .action(
      runAction((id: string, opts: { yes?: boolean }) => {
        requireYes(opts, "deleting this transaction");
        const db = getDb();
        if (!deleteTransaction(db, id)) fail("NOT_FOUND", `transaction "${id}" not found`);
        emit({ transaction_id: id, deleted: true });
      }),
    );
}
