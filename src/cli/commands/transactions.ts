import type { Command } from "commander";
import { randomUUID } from "crypto";
import { getDb } from "../../db/connection.js";
import {
  currentMode,
  emit,
  emitList,
  emitSummary,
  fail,
  readStdinToEnd,
  requireYes,
  runAction,
  type Column,
} from "../output.js";
import {
  insertTransaction,
  deleteTransaction,
  updateTransactionMeta,
  bulkRecategorize,
  listTransactions,
  countTransactions,
  clampListLimit,
  getTransaction,
  findDuplicateTransactions,
  voidTransactionAsMirror,
  type BulkRecategorizeFilter,
  type UpdateTransactionMetaFields,
  type ListTransactionsOptions,
  type TransactionRow,
  type TransactionCluster,
  type DuplicateTransactionRow,
} from "../../db/queries/transactions.js";
import { findAccountById } from "../../db/queries/account-balance.js";
import type { MerchantUpsertInput } from "../../db/queries/merchants.js";
import {
  commitTransaction,
  defaultTransactionCommitHooks,
  type TransactionCommitContext,
  type RawTransactionInput,
} from "../../ingest/commit-transaction.js";
import { autoMergeStrictDuplicateTransactions } from "../../ingest/dedup-transactions.js";
import { fromMinorUnits, toMinorUnits } from "../../currency.js";
import { applyRedaction } from "../../privacy/redactor.js";
import { todayIso } from "../../lib/date.js";
import * as z from "zod";
import { parseInput, str, num, json } from "../../lib/validate.js";
import { errorMessage } from "../../lib/result.js";

// `transactions`: list/show/add/update/delete/recategorize/dedupe over the
// TigerBeetle-style table. Amounts are minor units in the DB, decimals here (the CLI boundary).

// Read view (list / show)

// Free-text fields on a transaction that may carry PII. Ids, amount, currency, and
// dates are structured data the agent needs verbatim and are left intact.
const REDACT_FIELDS = [
  "description",
  "raw_descriptor",
  "merchant_name",
  "debit_account_name",
  "credit_account_name",
] as const;

/** A transaction row with its stored minor-unit amount converted to a decimal. */
type TransactionView = Omit<TransactionRow, "amount"> & { amount: number };

function present(row: TransactionRow): TransactionView {
  return { ...row, amount: fromMinorUnits(row.amount, row.currency) };
}

const LIST_COLUMNS: Column<TransactionView>[] = [
  { header: "ID", value: (t) => t.id },
  { header: "Date", value: (t) => t.date },
  { header: "Description", value: (t) => t.description },
  { header: "Debit", value: (t) => t.debit_account_name ?? t.debit_account_id },
  { header: "Credit", value: (t) => t.credit_account_name ?? t.credit_account_id },
  { header: "Amount", value: (t) => t.amount.toFixed(2), align: "right" },
  { header: "Currency", value: (t) => t.currency },
];

interface ListOpts {
  group?: boolean;
  redact?: boolean;
}

const LIST_TRANSACTIONS_SPEC = z.object({
  account: str().optional(),
  from: str().optional(),
  to: str().optional(),
  query: str().optional(),
  amount: num().optional(),
  currency: str().optional(),
  limit: num().optional(),
});

function runList(opts: ListOpts): void {
  const db = getDb();
  const parsed = parseInput(LIST_TRANSACTIONS_SPEC, opts as Record<string, unknown>);
  const listOpts: Omit<ListTransactionsOptions, "group"> = {};
  if (parsed.account) listOpts.account = parsed.account;
  if (parsed.from) listOpts.from = parsed.from;
  if (parsed.to) listOpts.to = parsed.to;
  if (parsed.query) listOpts.query = parsed.query;
  // Amount crosses the decimal -> minor-unit boundary here; currency defaults to
  // THB (the ledger's primary currency) when the caller doesn't pin one.
  if (parsed.amount !== undefined) {
    listOpts.amount = toMinorUnits(parsed.amount, parsed.currency ?? "THB");
  }
  if (parsed.limit !== undefined) listOpts.limit = parsed.limit;

  const total = countTransactions(db, listOpts);
  const limit = clampListLimit(listOpts.limit);

  if (opts.group) {
    const clusters = listTransactions(db, { ...listOpts, group: true });
    emitClusters(clusters, !!opts.redact);
    const returned = clusters.reduce((n, c) => n + c.transactions.length, 0);
    emitSummary({ total, returned, has_more: total > returned, limit });
    return;
  }

  const rows = applyRedaction(
    listTransactions(db, listOpts).map(present),
    !!opts.redact,
    REDACT_FIELDS,
  );
  emitList(rows, LIST_COLUMNS);
  emitSummary({ total, returned: rows.length, has_more: total > rows.length, limit });
}

function emitClusters(clusters: TransactionCluster[], redact: boolean): void {
  const view = clusters.map((c) => ({
    group_id: c.group_id,
    transactions: applyRedaction(c.transactions.map(present), redact, REDACT_FIELDS),
  }));
  const mode = currentMode();
  if (mode.json) {
    for (const c of view) emit(c);
    return;
  }
  for (const c of view) {
    process.stdout.write(`${c.group_id ?? "(ungrouped)"}\n`);
    for (const t of c.transactions) {
      process.stdout.write(
        `  ${t.id}  ${t.date}  ${t.description}  ${t.debit_account_name ?? t.debit_account_id} -> ${t.credit_account_name ?? t.credit_account_id}  ${t.amount.toFixed(2)} ${t.currency}\n`,
      );
    }
  }
}

function runShow(id: string, opts: { redact?: boolean }): void {
  const db = getDb();
  const detail = getTransaction(db, id);
  if (!detail) fail("NOT_FOUND", `transaction "${id}" not found`);

  const view: Record<string, unknown> = present(detail);
  if (detail.group) view.group = detail.group.map(present);
  emit(applyRedaction(view, !!opts.redact, REDACT_FIELDS));
}

// Dedupe (find / auto-merge duplicates)

function accountsLabel(
  debitName: string | null,
  debitId: string,
  creditName: string | null,
  creditId: string,
): string {
  return `${debitName ?? debitId} -> ${creditName ?? creditId}`;
}

// Presentation rows: minor-unit amounts converted to decimals at the CLI boundary.
interface DuplicateRow extends Omit<DuplicateTransactionRow, "amount"> {
  amount: number;
  group: number;
}

const DUPLICATE_COLUMNS: Column<DuplicateRow>[] = [
  { header: "group", value: (r) => String(r.group), align: "right" },
  { header: "id", value: (r) => r.id },
  { header: "date", value: (r) => r.date },
  { header: "amount", value: (r) => r.amount.toFixed(2), align: "right" },
  { header: "currency", value: (r) => r.currency },
  { header: "description", value: (r) => r.description },
  { header: "accounts", value: (r) => accountsLabel(r.debit_account_name, r.debit_account_id, r.credit_account_name, r.credit_account_id) },
  { header: "source_file_id", value: (r) => r.source_file_id ?? "" },
  { header: "merchant_id", value: (r) => r.merchant_id ?? "" },
];

function runDedupe(opts: { autoMerge?: boolean }): void {
  const db = getDb();

  let autoMerged: number | undefined;
  if (opts.autoMerge) {
    autoMerged = autoMergeStrictDuplicateTransactions(db).merged;
  }

  const groups = findDuplicateTransactions(db);
  const rows: DuplicateRow[] = groups.flatMap((group, i) =>
    group.map((t) => ({ ...t, amount: fromMinorUnits(t.amount, t.currency), group: i })),
  );

  emitList(rows, DUPLICATE_COLUMNS);
  emitSummary({
    groups: groups.length,
    ...(autoMerged !== undefined ? { auto_merged: autoMerged } : {}),
  });
}

// Merge (void a mirror into its surviving twin)

const MERGE_TRANSACTIONS_SPEC = z.object({
  from: str(),
  to: str(),
});

function mergeTransactionsAction(opts: { from?: string; to?: string; yes?: boolean }): void {
  const parsed = parseInput(MERGE_TRANSACTIONS_SPEC, opts as Record<string, unknown>);
  requireYes(opts, "merging transactions");
  const db = getDb();

  let result;
  try {
    result = voidTransactionAsMirror(db, parsed.from, parsed.to);
  } catch (err) {
    const message = errorMessage(err);
    if (/not found/i.test(message)) fail("NOT_FOUND", message);
    fail("INVALID", message);
  }

  if (result.alreadyVoid) {
    emit({ from: parsed.from, to: parsed.to, voided: false, already_void: true });
    return;
  }
  emit({ from: parsed.from, to: parsed.to, voided: true });
}

// Write path (add)

interface AddTransactionOpts {
  resolve?: boolean;
  debitAccount?: string;
  creditAccount?: string;
  amount?: string;
  date?: string;
  description?: string;
  merchantName?: string;
}

const ADD_TRANSACTION_FLAGS_SPEC = z.object({
  debit_account_id: str(),
  credit_account_id: str(),
  amount: num(),
  date: str().optional(),
  description: str().optional(),
});

const ADD_TRANSACTION_FLAGS_OPTS = {
  labels: { debit_account_id: "--debit-account", credit_account_id: "--credit-account" },
  aliases: { debit_account_id: ["debitAccount"], credit_account_id: ["creditAccount"] },
};

// Loose on required fields (debit/credit default to "", amount passes through
// unchecked): the strict/resolve checks in `addTransaction` stay the authority
// for exit codes and messages.
const ADD_TRANSACTION_STDIN_SPEC = z.object({
  date: str().default(""),
  description: str().optional(),
  debit_account_id: str().default(""),
  credit_account_id: str().default(""),
  currency: str().nullable().default(null),
  merchant: json<MerchantUpsertInput>().nullable().default(null),
  merchant_id: str().nullable().default(null),
  raw_descriptor: str().nullable().default(null),
  source_page: num().nullable().default(null),
  code: str().nullable().default(null),
});

const ADD_TRANSACTION_STDIN_ALIASES = {
  debit_account_id: ["debit_account"],
  credit_account_id: ["credit_account"],
};

// Builds a raw (decimal-amount) transaction from flags or stdin JSON; does not validate accounts.
async function buildRawTransaction(opts: AddTransactionOpts): Promise<RawTransactionInput> {
  const anyFlag =
    opts.debitAccount !== undefined || opts.creditAccount !== undefined || opts.amount !== undefined;

  if (anyFlag) {
    const parsed = parseInput(
      ADD_TRANSACTION_FLAGS_SPEC,
      opts as Record<string, unknown>,
      ADD_TRANSACTION_FLAGS_OPTS,
    );

    const raw: RawTransactionInput = {
      date: parsed.date ?? todayIso(),
      description: parsed.description ?? opts.merchantName ?? "Manual entry",
      debit_account_id: parsed.debit_account_id,
      credit_account_id: parsed.credit_account_id,
      amount: parsed.amount,
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
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdin);
  } catch (err) {
    fail("USAGE", `invalid JSON on stdin: ${(err as Error).message}`);
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    fail("USAGE", "stdin must contain a single JSON transaction object (not an array)");
  }
  const record = decoded as Record<string, unknown>;
  const parsed = parseInput(ADD_TRANSACTION_STDIN_SPEC, record, {
    aliases: ADD_TRANSACTION_STDIN_ALIASES,
  });
  return {
    ...parsed,
    // Description prefers an explicit value, then the merchant's canonical name.
    description: parsed.description ?? parsed.merchant?.canonical_name ?? "Manual entry",
    // amount's number check is owned by the strict/resolve validators below, so it
    // passes through un-coerced (keeping their exit codes and messages).
    amount: record.amount as number,
  };
}

async function addTransaction(opts: AddTransactionOpts): Promise<void> {
  const db = getDb();
  const raw = await buildRawTransaction(opts);

  if (opts.resolve) {
    const batchId = `ib:${randomUUID()}`;
    const ctx: TransactionCommitContext = {
      batchId,
      fileId: null,
      fileHash: null,
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

const UPDATE_TRANSACTION_SPEC = z.object({
  date: str().optional(),
  description: str().optional(),
  merchant_id: str().optional(),
});

const UPDATE_TRANSACTION_ALIASES = { merchant_id: ["merchant"] };

const RECATEGORIZE_SPEC = z.object({
  set_account: str(),
  filter_account: str(),
});

// The `--filter-account` clarification is folded into the label so a missing
// flag still explains what that account controls.
const RECATEGORIZE_LABELS = {
  filter_account: "--filter-account (recategorize moves that account's transactions)",
};

export function registerTransactions(program: Command): void {
  const transactions = program
    .command("transactions")
    .description("Transactions: list / show / add / update / delete / recategorize / dedupe");

  transactions
    .command("list")
    .description("List transactions with optional filters")
    .option("--account <id>", "filter by account id (matches either side)")
    .option("--from <date>", "filter from date")
    .option("--to <date>", "filter to date")
    .option("--query <text>", "filter by search text")
    .option("--amount <decimal>", "filter by exact amount (decimal)")
    .option("--currency <code>", "currency for --amount (default THB)")
    .option("--limit <n>", "max rows (default 50, max 500)")
    .option("--group", "fold linked transactions into their group clusters")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction((opts: ListOpts) => runList(opts)));

  transactions
    .command("show <id>")
    .description("Show a transaction's details (with its linked group when present)")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction((id: string, opts: { redact?: boolean }) => runShow(id, opts)));

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
    .command("update <id>")
    .description("Update a transaction's metadata")
    .option("--date <date>", "transaction date")
    .option("--description <text>", "transaction description")
    .option("--merchant <id>", "merchant id to set")
    .action(
      runAction((id: string, opts: Record<string, unknown>) => {
        const fields: UpdateTransactionMetaFields = parseInput(UPDATE_TRANSACTION_SPEC, opts, {
          aliases: UPDATE_TRANSACTION_ALIASES,
          atLeastOne: "at least one of --date, --description, --merchant is required",
        });
        const db = getDb();
        const changes = updateTransactionMeta(db, id, fields);
        if (changes === 0) fail("NOT_FOUND", `transaction "${id}" not found`);
        emit({ transaction_id: id, updated: true });
      }),
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

  transactions
    .command("recategorize")
    .description("Bulk re-point one account's transactions onto another")
    .option("--set-account <id>", "account id to move matching transactions to")
    .option("--filter-account <id>", "account whose transactions are moved (required)")
    .action(
      runAction(
        (opts: Record<string, unknown>) => {
          const parsed = parseInput(RECATEGORIZE_SPEC, opts, { labels: RECATEGORIZE_LABELS });
          const db = getDb();
          const filter: BulkRecategorizeFilter = { accountId: parsed.filter_account };

          let result;
          try {
            result = bulkRecategorize(db, filter, { accountId: parsed.set_account });
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
    .command("dedupe")
    .description("Find likely duplicate transactions (optionally auto-merge them)")
    .option("--auto-merge", "automatically merge detected duplicates")
    .action(runAction((opts: { autoMerge?: boolean }) => runDedupe(opts)));

  transactions
    .command("merge")
    .description("Merge a mirror transaction into its surviving twin (voids --from)")
    .option("--from <id>", "mirror transaction id to void")
    .option("--to <id>", "surviving transaction id")
    .option("--yes", "skip confirmation")
    .action(runAction(mergeTransactionsAction));
}
