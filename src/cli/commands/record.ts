import type { Command } from "commander";
import { randomUUID } from "crypto";
import { getDb } from "../../db/connection.js";
import { emit, fail, readStdinToEnd, requireYes, runAction } from "../output.js";
import {
  insertTransfer,
  deleteTransfer,
  updateTransferMeta,
  bulkRecategorize,
  type BulkRecategorizeFilter,
  type UpdateTransferMetaFields,
} from "../../db/queries/transfers.js";
import { findAccountById } from "../../db/queries/account-balance.js";
import {
  commitTransfer,
  defaultTransferCommitHooks,
  type TransferCommitContext,
  type RawTransferInput,
} from "../../scanner/commit-transfer.js";
import { toMinorUnits } from "../../currency.js";

/**
 * `record` — the write command for the transfer ledger. Bare `record` creates a
 * transfer (strict by default: both accounts must already exist; `--resolve`
 * fuzzy-resolves account/merchant hints and raises questions). Subcommands
 * cover bulk recategorize, metadata edits, and deletion.
 */

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface RecordCreateOpts {
  resolve?: boolean;
  debitAccount?: string;
  creditAccount?: string;
  amount?: string;
  currency?: string;
  date?: string;
  description?: string;
  merchantName?: string;
}

/** Build a raw (decimal-amount) transfer from convenience flags or a JSON object
 *  on stdin. Does not validate accounts — the create path does that. */
async function buildRawTransfer(opts: RecordCreateOpts): Promise<RawTransferInput> {
  const anyFlag =
    opts.debitAccount !== undefined || opts.creditAccount !== undefined || opts.amount !== undefined;

  if (anyFlag) {
    const missing: string[] = [];
    if (!opts.debitAccount) missing.push("--debit-account");
    if (!opts.creditAccount) missing.push("--credit-account");
    if (opts.amount === undefined) missing.push("--amount");
    if (missing.length) fail("USAGE", `record requires ${missing.join(", ")}`);

    const amount = Number(opts.amount);
    if (!Number.isFinite(amount)) fail("USAGE", `--amount must be a number, got "${opts.amount}"`);

    const raw: RawTransferInput = {
      date: opts.date ?? todayIso(),
      description: opts.description ?? opts.merchantName ?? "Manual entry",
      debit_account_id: opts.debitAccount!,
      credit_account_id: opts.creditAccount!,
      amount,
      currency: opts.currency ?? null,
    };
    if (opts.merchantName) raw.merchant = { canonical_name: opts.merchantName };
    return raw;
  }

  const stdin = await readStdinToEnd();
  if (!stdin.trim()) {
    fail(
      "USAGE",
      "provide --debit-account/--credit-account/--amount, or pipe a transfer JSON object on stdin",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch (err) {
    fail("USAGE", `invalid JSON on stdin: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("USAGE", "stdin must contain a single JSON transfer object (not an array)");
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

async function recordCreate(opts: RecordCreateOpts): Promise<void> {
  const db = getDb();
  const raw = await buildRawTransfer(opts);

  if (opts.resolve) {
    const scanId = `sc:${randomUUID()}`;
    const ctx: TransferCommitContext = {
      scanId,
      fileId: null,
      fileHash: null,
      chunkId: null,
      progress: null,
    };
    const outcome = commitTransfer(db, ctx, raw, defaultTransferCommitHooks(db, ctx));
    if (!outcome.ok) {
      if (outcome.reason === "currency_mismatch") {
        fail("INVALID", outcome.message, {
          hint: "record a linked conversion pair (one leg per currency, sharing a group)",
        });
      }
      fail("INVALID", outcome.message);
    }
    emit({
      transfer_id: outcome.transferId,
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

  // Currency is derived from the resolved accounts; a cross-currency transfer is
  // rejected (record it as a linked conversion pair instead).
  const currency = debit.currency || "THB";
  if ((credit.currency || "THB") !== currency) {
    fail(
      "INVALID",
      `debit ${debit.id} is ${currency}, credit ${credit.id} is ${credit.currency}; a single transfer can't cross currencies`,
      { hint: "record a linked conversion pair (one leg per currency, sharing a group)" },
    );
  }

  let result: { id: string; duplicate: boolean };
  try {
    result = insertTransfer(db, {
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
  emit({ transfer_id: result.id, duplicate: result.duplicate });
}

export function registerRecord(program: Command): void {
  const record = program
    .command("record")
    // record has a bare create action AND subcommands (update/delete/...). Some
    // option names are shared (e.g. --date/--description on both create and
    // `record update`); positional options make options AFTER a subcommand name
    // bind to the subcommand instead of being swallowed by the parent action.
    .enablePositionalOptions()
    .description("Record a manual transfer (bare = create); statement rows belong in `ingest commit`")
    .option("--resolve", "fuzzy-resolve account/merchant hints and raise questions instead of failing")
    .option("--debit-account <id>", "debit account id")
    .option("--credit-account <id>", "credit account id")
    .option("--amount <n>", "transfer amount (decimal)")
    .option("--currency <code>", "currency code (defaults to the accounts' currency)")
    .option("--date <date>", "transfer date (defaults to today)")
    .option("--description <text>", "transfer description")
    .option("--merchant-name <name>", "merchant name to upsert and link")
    .action(runAction((opts: RecordCreateOpts) => recordCreate(opts)));

  record
    .command("recategorize")
    .description("Bulk re-point one account's transfers onto another")
    .option("--set-account <id>", "account id to move matching transfers to")
    .option("--filter-account <id>", "account whose transfers are moved (required)")
    .option("--filter-desc <text>", "only transfers whose description contains this")
    .option("--filter-merchant <id>", "only transfers with this merchant id")
    .option("--filter-currency <code>", "only transfers in this currency")
    .option("--from <date>", "filter from date")
    .option("--to <date>", "filter to date")
    .action(
      runAction(
        (opts: {
          setAccount?: string;
          filterAccount?: string;
          filterDesc?: string;
          filterMerchant?: string;
          filterCurrency?: string;
          from?: string;
          to?: string;
        }) => {
          if (!opts.setAccount) fail("USAGE", "--set-account is required");
          if (!opts.filterAccount) {
            fail("USAGE", "--filter-account is required (recategorize moves that account's transfers)");
          }
          const db = getDb();
          const filter: BulkRecategorizeFilter = { accountId: opts.filterAccount };
          if (opts.filterDesc) filter.descriptionContains = opts.filterDesc;
          if (opts.filterMerchant) filter.merchantId = opts.filterMerchant;
          if (opts.filterCurrency) filter.currency = opts.filterCurrency;
          if (opts.from) filter.from = opts.from;
          if (opts.to) filter.to = opts.to;

          let result;
          try {
            result = bulkRecategorize(db, filter, { accountId: opts.setAccount });
          } catch (err) {
            fail("INVALID", (err as Error).message);
          }
          emit({
            affected: result.affected,
            skipped_self_transfer: result.skipped_self_transfer,
            sample_transfer_ids: result.sample_transfer_ids,
          });
        },
      ),
    );

  record
    .command("update <id>")
    .description("Update a transfer's metadata")
    .option("--date <date>", "transfer date")
    .option("--description <text>", "transfer description")
    .option("--merchant <id>", "merchant id to set")
    .option("--source-page <n>", "source page number")
    .action(
      runAction(
        (
          id: string,
          opts: { date?: string; description?: string; merchant?: string; sourcePage?: string },
        ) => {
          const fields: UpdateTransferMetaFields = {};
          if (opts.date !== undefined) fields.date = opts.date;
          if (opts.description !== undefined) fields.description = opts.description;
          if (opts.merchant !== undefined) fields.merchant_id = opts.merchant;
          if (opts.sourcePage !== undefined) {
            const sp = Number(opts.sourcePage);
            if (!Number.isFinite(sp)) {
              fail("USAGE", `--source-page must be a number, got "${opts.sourcePage}"`);
            }
            fields.source_page = sp;
          }
          if (Object.keys(fields).length === 0) {
            fail("USAGE", "at least one of --date, --description, --merchant, --source-page is required");
          }
          const db = getDb();
          const changes = updateTransferMeta(db, id, fields);
          if (changes === 0) fail("NOT_FOUND", `transfer "${id}" not found`);
          emit({ transfer_id: id, updated: true });
        },
      ),
    );

  record
    .command("delete <id>")
    .description("Delete a transfer")
    .option("--yes", "skip confirmation")
    .action(
      runAction((id: string, opts: { yes?: boolean }) => {
        requireYes(opts, "deleting this transfer");
        const db = getDb();
        if (!deleteTransfer(db, id)) fail("NOT_FOUND", `transfer "${id}" not found`);
        emit({ transfer_id: id, deleted: true });
      }),
    );
}
