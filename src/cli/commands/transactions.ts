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
  getTransaction,
  findDuplicateTransactions,
  type BulkRecategorizeFilter,
  type UpdateTransactionMetaFields,
  type ListTransactionsOptions,
  type TransactionRow,
  type TransactionCluster,
  type DuplicateTransactionRow,
} from "../../db/queries/transactions.js";
import { findAccountById } from "../../db/queries/account-balance.js";
import {
  commitTransaction,
  defaultTransactionCommitHooks,
  type TransactionCommitContext,
  type RawTransactionInput,
} from "../../scanner/commit-transaction.js";
import { autoMergeStrictDuplicateTransactions } from "../../scanner/dedup-transactions.js";
import { fromMinorUnits, toMinorUnits } from "../../currency.js";
import { applyRedaction } from "../../privacy/redactor.js";
import { todayIso } from "../../lib/date.js";
import { parseInput, str, num } from "../../lib/validate.js";

/**
 * `transactions` — the full command surface over the TigerBeetle-style
 * `transactions` table. Read: `transactions list` (bare list with filters) and
 * `transactions show <tx:id>` (one transaction with its linked group). Write:
 * `add` (strict by default; `--resolve` fuzzy-resolves account/merchant hints
 * and raises questions), `update`, `delete`, `recategorize` (bulk re-point), and
 * `dedupe` (find, optionally auto-merge, likely duplicates). Amounts are stored
 * as integer minor units and rendered/emitted as decimals here (the CLI
 * boundary).
 */

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

const LIST_TRANSACTIONS_SPEC = {
  account: str().optional(),
  from: str().optional(),
  to: str().optional(),
  query: str().optional(),
  limit: num().optional(),
};

function runList(opts: ListOpts): void {
  const db = getDb();
  const parsed = parseInput(LIST_TRANSACTIONS_SPEC, opts as Record<string, unknown>);
  const listOpts: Omit<ListTransactionsOptions, "group"> = {};
  if (parsed.account) listOpts.account = parsed.account;
  if (parsed.from) listOpts.from = parsed.from;
  if (parsed.to) listOpts.to = parsed.to;
  if (parsed.query) listOpts.query = parsed.query;
  if (parsed.limit !== undefined) listOpts.limit = parsed.limit;

  if (opts.group) {
    const clusters = listTransactions(db, { ...listOpts, group: true });
    emitClusters(clusters, !!opts.redact);
    return;
  }

  const rows = applyRedaction(
    listTransactions(db, listOpts).map(present),
    !!opts.redact,
    REDACT_FIELDS,
  );
  emitList(rows, LIST_COLUMNS);
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

const ADD_TRANSACTION_FLAGS_SPEC = {
  debit_account_id: str().required("--debit-account").alias("debitAccount"),
  credit_account_id: str().required("--credit-account").alias("creditAccount"),
  amount: num().required("--amount"),
  date: str().optional(),
  description: str().optional(),
};

/** Build a raw (decimal-amount) transaction from convenience flags or a JSON object
 *  on stdin. Does not validate accounts — the create path does that. */
async function buildRawTransaction(opts: AddTransactionOpts): Promise<RawTransactionInput> {
  const anyFlag =
    opts.debitAccount !== undefined || opts.creditAccount !== undefined || opts.amount !== undefined;

  if (anyFlag) {
    const parsed = parseInput(ADD_TRANSACTION_FLAGS_SPEC, opts as Record<string, unknown>);

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

const UPDATE_TRANSACTION_SPEC = {
  date: str().optional(),
  description: str().optional(),
  merchant_id: str().optional().alias("merchant"),
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
    .option("--limit <n>", "maximum number of results")
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
    .command("dedupe")
    .description("Find likely duplicate transactions (optionally auto-merge them)")
    .option("--auto-merge", "automatically merge detected duplicates")
    .action(runAction((opts: { autoMerge?: boolean }) => runDedupe(opts)));
}
