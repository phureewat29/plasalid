import type { Command } from "commander";
import { randomUUID } from "crypto";
import { getDb } from "../../db/connection.js";
import { emit, fail, readStdinToEnd, requireYes, runAction } from "../output.js";
import {
  recordTransaction,
  getTransaction,
  updateTransaction,
  deleteTransaction,
  bulkUpdatePostings,
  validateTransaction,
  type TransactionInput,
  type PostingInput,
  type BulkUpdatePostingsFilter,
  type BulkUpdatePostingsSet,
  type UpdateTransactionFields,
} from "../../db/queries/transactions.js";
import { findAccountById } from "../../db/queries/account-balance.js";
import {
  commitTransaction,
  defaultCommitHooks,
  type CommitContext,
} from "../../scanner/commit.js";
import { applyRedaction } from "../../privacy/redactor.js";

// Free-text fields on a TransactionDetail (and its nested postings) that may
// carry PII. Ids, amounts, currency, dates, and account_id are excluded.
const TX_REDACT_FIELDS = [
  "description",
  "raw_descriptor",
  "merchant_name",
  "memo",
  "account_name",
] as const;

interface TxAddOptions {
  resolve?: boolean;
  date?: string;
  description?: string;
  amount?: string;
  debitAccount?: string;
  creditAccount?: string;
  currency?: string;
  merchantName?: string;
}

const CONVENIENCE_FLAGS: (keyof TxAddOptions)[] = [
  "date",
  "description",
  "amount",
  "debitAccount",
  "creditAccount",
];
const CONVENIENCE_FLAG_NAMES: Record<string, string> = {
  date: "--date",
  description: "--description",
  amount: "--amount",
  debitAccount: "--debit-account",
  creditAccount: "--credit-account",
};

async function buildTransactionInput(opts: TxAddOptions): Promise<TransactionInput> {
  const anyGiven = CONVENIENCE_FLAGS.some((k) => opts[k] !== undefined);
  if (anyGiven) {
    const missing = CONVENIENCE_FLAGS.filter((k) => opts[k] === undefined).map(
      (k) => CONVENIENCE_FLAG_NAMES[k],
    );
    if (missing.length) {
      fail("USAGE", `convenience mode requires ${missing.join(", ")}`);
    }
    const amount = Number(opts.amount);
    if (!Number.isFinite(amount)) {
      fail("USAGE", `--amount must be a number, got "${opts.amount}"`);
    }
    const postings: PostingInput[] = [
      { account_id: opts.debitAccount!, debit: amount, currency: opts.currency },
      { account_id: opts.creditAccount!, credit: amount, currency: opts.currency },
    ];
    const input: TransactionInput = {
      date: opts.date!,
      description: opts.description!,
      postings,
    };
    if (opts.merchantName) input.merchant = { canonical_name: opts.merchantName };
    return input;
  }

  const raw = await readStdinToEnd();
  if (!raw.trim()) {
    fail(
      "USAGE",
      "provide --date/--description/--amount/--debit-account/--credit-account, or pipe a transaction JSON object on stdin",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail("USAGE", `invalid JSON on stdin: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("USAGE", "stdin must contain a single JSON transaction object (not an array)");
  }
  return parsed as TransactionInput;
}

export function registerTx(program: Command): void {
  const tx = program.command("tx").description("Manage transactions");

  tx
    .command("add")
    .description("Add a new transaction")
    .option("--resolve", "auto-resolve accounts and merchants")
    .option("--date <date>", "transaction date")
    .option("--description <text>", "transaction description")
    .option("--amount <n>", "transaction amount")
    .option("--debit-account <id>", "debit account id")
    .option("--credit-account <id>", "credit account id")
    .option("--currency <code>", "currency code")
    .option("--merchant-name <name>", "merchant name")
    .action(
      runAction(async (opts: TxAddOptions) => {
        const db = getDb();
        const input = await buildTransactionInput(opts);

        if (opts.resolve) {
          const scanId = `sc:${randomUUID()}`;
          const ctx: CommitContext = {
            scanId,
            fileId: null,
            chunkId: null,
            progress: null,
          };
          const hooks = defaultCommitHooks(db, ctx);
          const outcome = commitTransaction(db, ctx, input, hooks);
          if (!outcome.ok) {
            fail("INVALID", outcome.message);
          }
          emit({
            transaction_id: outcome.transactionId,
            raised_questions: outcome.raisedQuestions,
          });
          return;
        }

        let validated: TransactionInput & { id: string };
        try {
          validated = validateTransaction(input);
        } catch (err) {
          fail("INVALID", (err as Error).message);
        }
        for (const p of validated.postings) {
          if (!findAccountById(db, p.account_id)) {
            fail("NOT_FOUND", `account "${p.account_id}" not found`, {
              hint:
                "create it with `plasalid accounts create`, " +
                "or find a close match with `plasalid accounts match --query <name>`",
            });
          }
        }
        const id = recordTransaction(db, validated);
        emit({ transaction_id: id });
      }),
    );

  tx
    .command("show <id>")
    .description("Show a transaction's details")
    .option("--redact", "mask PII in free-text fields (description, memos, merchant name)")
    .action(
      runAction((id: string, opts: { redact?: boolean }) => {
        const db = getDb();
        const detail = getTransaction(db, id);
        if (!detail) fail("NOT_FOUND", `transaction "${id}" not found`);
        emit(applyRedaction(detail, !!opts.redact, TX_REDACT_FIELDS));
      }),
    );

  tx
    .command("update <id>")
    .description("Update a transaction")
    .option("--date <date>", "transaction date")
    .option("--description <text>", "transaction description")
    .option("--source-page <n>", "source page number")
    .action(
      runAction(
        (id: string, opts: { date?: string; description?: string; sourcePage?: string }) => {
          const db = getDb();
          const fields: UpdateTransactionFields = {};
          if (opts.date !== undefined) fields.date = opts.date;
          if (opts.description !== undefined) fields.description = opts.description;
          if (opts.sourcePage !== undefined) {
            const sp = Number(opts.sourcePage);
            if (!Number.isFinite(sp)) {
              fail("USAGE", `--source-page must be a number, got "${opts.sourcePage}"`);
            }
            fields.source_page = sp;
          }
          if (Object.keys(fields).length === 0) {
            fail("USAGE", "at least one of --date, --description, --source-page is required");
          }
          const changes = updateTransaction(db, id, fields);
          if (changes === 0) fail("NOT_FOUND", `transaction "${id}" not found`);
          emit({ transaction_id: id, updated: true });
        },
      ),
    );

  tx
    .command("delete <id>")
    .description("Delete a transaction")
    .option("--yes", "skip confirmation")
    .action(
      runAction((id: string, opts: { yes?: boolean }) => {
        requireYes(opts, "deleting this transaction");
        const db = getDb();
        const changes = deleteTransaction(db, id);
        if (changes === 0) fail("NOT_FOUND", `transaction "${id}" not found`);
        emit({ transaction_id: id, deleted: true });
      }),
    );

  tx
    .command("recategorize")
    .description("Bulk recategorize transactions")
    .option("--set-account <id>", "account id to set")
    .option("--set-memo <text>", "memo to set")
    .option("--filter-account <id>", "filter by account id")
    .option("--filter-desc <text>", "filter by description")
    .option("--filter-merchant <id>", "filter by merchant id")
    .option("--filter-currency <code>", "filter by currency code")
    .option("--from <date>", "filter from date")
    .option("--to <date>", "filter to date")
    .action(
      runAction(
        (opts: {
          setAccount?: string;
          setMemo?: string;
          filterAccount?: string;
          filterDesc?: string;
          filterMerchant?: string;
          filterCurrency?: string;
          from?: string;
          to?: string;
        }) => {
          const db = getDb();
          const filter: BulkUpdatePostingsFilter = {};
          if (opts.filterAccount) filter.account_id = opts.filterAccount;
          if (opts.filterDesc) filter.description_contains = opts.filterDesc;
          if (opts.filterMerchant) filter.merchant_id = opts.filterMerchant;
          if (opts.filterCurrency) filter.currency = opts.filterCurrency;
          if (opts.from) filter.from = opts.from;
          if (opts.to) filter.to = opts.to;
          if (Object.keys(filter).length === 0) {
            fail(
              "USAGE",
              "at least one --filter-* flag is required (--filter-account, --filter-desc, --filter-merchant, --filter-currency, --from, --to)",
            );
          }

          const set: BulkUpdatePostingsSet = {};
          if (opts.setAccount !== undefined) set.account_id = opts.setAccount;
          if (opts.setMemo !== undefined) set.memo = opts.setMemo;
          if (Object.keys(set).length === 0) {
            fail("USAGE", "at least one of --set-account or --set-memo is required");
          }

          let result;
          try {
            result = bulkUpdatePostings(db, filter, set);
          } catch (err) {
            fail("INVALID", (err as Error).message);
          }
          emit({
            affected: result.affected,
            sample_posting_ids: result.sample_posting_ids.slice(0, 5),
          });
        },
      ),
    );
}
