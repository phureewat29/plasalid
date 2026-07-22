import { randomUUID } from "crypto";
import type {
  TransactionCommitContext,
  TransactionCommitHooks,
  TransactionSide,
  RawTransactionInput,
  LinkedTransactionHeader,
  LinkedTransactionLeg,
} from "../../ingest/commit-transaction.js";
import { EXIT, asRecord, currentMode, emit, emitSummary, fail, readStdinBatch } from "../output.js";
import { emitObject, openDb } from "./ingest.js";
import * as z from "zod";
import { safeParse, str, num, json } from "../../lib/validate.js";
import type { MerchantUpsertInput } from "../../db/queries/merchants.js";

/**
 * `ingest commit`: reads an NDJSON/JSON batch from stdin (or --input) and
 * posts each row as a transaction (or linked group), reporting per-row
 * resolution detail (fuzzy-match vs. placeholder vs. exact) alongside ok/duplicate/failed.
 */

interface CommitOpts {
  file?: string;
  input?: string;
}

type SideHow = "exact" | "fuzzy_matched" | "placeholder_created" | "uncategorized_fallback";

type CommitEvent =
  | { kind: "placeholder"; side: TransactionSide; accountId: string }
  | { kind: "fuzzy"; side: TransactionSide; originalId: string; matchedId: string }
  | { kind: "unknown_merchant"; attemptedId: string }
  | { kind: "dirty"; reason: string }
  | { kind: "currency_mismatch" };

// Delegates to the default hooks (so questions still raise) while capturing a
// typed event per callback, to build the per-side resolution report afterwards.
function makeRecordingHooks(base: TransactionCommitHooks, events: CommitEvent[]): TransactionCommitHooks {
  return {
    onCommitted: (id) => base.onCommitted(id),
    onDirtyInput: (input, reason) => {
      base.onDirtyInput(input, reason);
      events.push({ kind: "dirty", reason });
    },
    onUnknownMerchant: (input, id, attemptedId) => {
      base.onUnknownMerchant(input, id, attemptedId);
      events.push({ kind: "unknown_merchant", attemptedId });
    },
    onPlaceholderAccount: (side, accountId, id) => {
      base.onPlaceholderAccount(side, accountId, id);
      events.push({ kind: "placeholder", side, accountId });
    },
    // No event needed: classifySide infers uncategorized_fallback from the
    // absence of a placeholder/fuzzy event plus the requested id not existing.
    onUncategorizedFallback: (side, accountId, id) => base.onUncategorizedFallback(side, accountId, id),
    onSimilarAccount: (side, originalId, matchedId, id) => {
      base.onSimilarAccount(side, originalId, matchedId, id);
      events.push({ kind: "fuzzy", side, originalId, matchedId });
    },
    onCurrencyMismatch: (input, debit, credit) => {
      base.onCurrencyMismatch(input, debit, credit);
      events.push({ kind: "currency_mismatch" });
    },
  };
}

// Derived from hook events + a post-commit existence check, NOT the stored row:
// a duplicate re-commit fires no hooks, so a missing event still reads as "exact".
function classifySide(
  requested: string,
  side: TransactionSide,
  events: CommitEvent[],
  accountExists: (id: string) => boolean,
): { resolved: string; how: SideHow } {
  const fuzzy = events.find(
    (e): e is Extract<CommitEvent, { kind: "fuzzy" }> =>
      e.kind === "fuzzy" && e.side === side && e.originalId === requested,
  );
  if (fuzzy) return { resolved: fuzzy.matchedId, how: "fuzzy_matched" };

  const placeholder = events.find(
    (e) => e.kind === "placeholder" && e.side === side && e.accountId === requested,
  );
  if (placeholder) return { resolved: requested, how: "placeholder_created" };

  if (accountExists(requested)) return { resolved: requested, how: "exact" };
  return { resolved: "expense:uncategorized", how: "uncategorized_fallback" };
}

function classifyMerchant(
  item: { merchant?: unknown; merchant_id?: unknown },
  events: CommitEvent[],
  resolvedMerchantId: () => string | null | undefined,
): { how: string; merchant_id?: string } {
  const hadMerchant = !!(item.merchant || item.merchant_id);
  if (!hadMerchant) return { how: "none" };
  if (events.some((e) => e.kind === "unknown_merchant")) return { how: "unknown" };
  const mid = resolvedMerchantId();
  return { how: "linked", merchant_id: mid ?? undefined };
}

// Loose by design: shape + defaults + aliasing only. `validateRawTransaction`
// stays the authority on validity, so missing required fields default to ""
// and surface there as `dirty_input`. `amount` is excluded so its raw type
// reaches the validator's `typeof` check unconverted by `num()`.
const LINKED_HEADER_SPEC = z.object({
  date: str().default(""),
  description: str().default(""),
  raw_descriptor: str().nullable().default(null),
  source_page: num().nullable().default(null),
  merchant: json<MerchantUpsertInput>().nullable().default(null),
  merchant_id: str().nullable().default(null),
  group_id: str().nullable().default(null),
  row_index: num().nullable().default(null),
});

const LINKED_LEG_SPEC = z.object({
  debit_account_id: str().default(""),
  credit_account_id: str().default(""),
  currency: str().nullable().default(null),
  description: str().optional(),
  code: str().nullable().default(null),
});

const STANDALONE_SPEC = z.object({
  id: str().optional(),
  date: str().default(""),
  description: str().default(""),
  raw_descriptor: str().nullable().default(null),
  source_page: num().nullable().default(null),
  row_index: num().nullable().default(null),
  merchant: json<MerchantUpsertInput>().nullable().default(null),
  merchant_id: str().nullable().default(null),
  debit_account_id: str().default(""),
  credit_account_id: str().default(""),
  currency: str().nullable().default(null),
  code: str().nullable().default(null),
});

// debit/credit accept a snake_case synonym that isn't the camelCase auto-bridge.
const LEG_ALIASES = {
  debit_account_id: ["debit_account"],
  credit_account_id: ["credit_account"],
};

export async function ingestCommit(opts: CommitOpts): Promise<void> {
  const items = await readStdinBatch(opts.input);
  if (items.length === 0) fail("USAGE", "no transaction data provided");

  const db = await openDb();
  const { commitTransaction, commitLinkedTransactions, defaultTransactionCommitHooks } = await import(
    "../../ingest/commit-transaction.js"
  );
  const { getTransaction } = await import("../../db/queries/transactions.js");
  const { findAccountById } = await import("../../db/queries/account-balance.js");
  const { findFileById } = await import("../../db/queries/files.js");
  const accountExists = (id: string): boolean => !!findAccountById(db, id);

  // Must be non-null: raise() no-ops when batchId is null, silently dropping every question.
  const batchId = `ib:${randomUUID()}`;

  // Derive the deterministic-id source hash from the files row (cached).
  const fileHashCache = new Map<string, string | null>();
  const fileHashFor = (fileId: string | null): string | null => {
    if (!fileId) return null;
    if (!fileHashCache.has(fileId)) {
      fileHashCache.set(fileId, findFileById(db, fileId)?.file_hash ?? null);
    }
    return fileHashCache.get(fileId) ?? null;
  };

  const results: Record<string, unknown>[] = [];
  let posted = 0;
  let duplicates = 0;
  let failed = 0;
  let raisedTotal = 0;

  // A row rejected before the commit pipeline (bad JSON shape) reuses the loop's
  // per-row failure shape so the PARTIAL contract holds — never throws.
  const failRow = (index: number, message: string): void => {
    failed++;
    results.push({ type: "result", index, ok: false, reason: "dirty_input", message, raised_questions: 0 });
  };

  for (let index = 0; index < items.length; index++) {
    const record = asRecord(items[index]);
    if (!record) {
      failRow(index, "each transaction must be a JSON object.");
      continue;
    }

    const fileId = ((record.source_file_id as string | null | undefined) ?? opts.file) ?? null;
    const ctx: TransactionCommitContext = {
      batchId,
      fileId,
      fileHash: fileHashFor(fileId),
    };
    const events: CommitEvent[] = [];
    const hooks = makeRecordingHooks(defaultTransactionCommitHooks(db, ctx), events);

    const linked = record.linked;
    const isCompound = Array.isArray(linked) && linked.length > 0;

    if (isCompound) {
      const parsedHeader = safeParse(LINKED_HEADER_SPEC, record);
      if (!parsedHeader.ok) {
        failRow(index, parsedHeader.error);
        continue;
      }
      const header: LinkedTransactionHeader = { ...parsedHeader.value, source_file_id: fileId };

      const legs: LinkedTransactionLeg[] = [];
      let legError: string | undefined;
      for (const rawLeg of linked) {
        const legRecord = asRecord(rawLeg);
        if (!legRecord) {
          legError = "each linked leg must be a JSON object.";
          break;
        }
        const parsedLeg = safeParse(LINKED_LEG_SPEC, legRecord, { aliases: LEG_ALIASES });
        if (!parsedLeg.ok) {
          legError = parsedLeg.error;
          break;
        }
        // Cast is a lie for malformed rows — validateRawTransaction rejects those.
        legs.push({ ...parsedLeg.value, amount: legRecord.amount as number });
      }
      if (legError !== undefined) {
        failRow(index, legError);
        continue;
      }

      const outcome = commitLinkedTransactions(db, ctx, header, legs, hooks);
      raisedTotal += outcome.raisedQuestions;

      if (!outcome.ok) {
        failed++;
        results.push({
          type: "result",
          index,
          ok: false,
          reason: outcome.reason,
          message: outcome.message,
          raised_questions: outcome.raisedQuestions,
        });
        continue;
      }

      const allDuplicate = outcome.results.every((r) => r.duplicate);
      if (allDuplicate) duplicates++;
      else posted++;

      results.push({
        type: "result",
        index,
        ok: true,
        group_id: outcome.group_id,
        legs: outcome.results.map((r) => ({ transaction_id: r.id, duplicate: r.duplicate })),
        duplicate: allDuplicate,
        raised_questions: outcome.raisedQuestions,
        merchant: classifyMerchant(parsedHeader.value, events, () =>
          getTransaction(db, outcome.results[0]?.id)?.merchant_id,
        ),
      });
      continue;
    }

    // Standalone transaction.
    const parsed = safeParse(STANDALONE_SPEC, record, { aliases: LEG_ALIASES });
    if (!parsed.ok) {
      failRow(index, parsed.error);
      continue;
    }
    // Cast is a lie for malformed rows — validateRawTransaction rejects those.
    const raw: RawTransactionInput = {
      ...parsed.value,
      source_file_id: fileId,
      amount: record.amount as number,
    };

    const outcome = commitTransaction(db, ctx, raw, hooks);
    raisedTotal += outcome.raisedQuestions;

    if (!outcome.ok) {
      failed++;
      results.push({
        type: "result",
        index,
        ok: false,
        reason: outcome.reason,
        message: outcome.message,
        raised_questions: outcome.raisedQuestions,
      });
      continue;
    }

    if (outcome.duplicate) duplicates++;
    else posted++;

    results.push({
      type: "result",
      index,
      ok: true,
      transaction_id: outcome.transactionId,
      duplicate: outcome.duplicate,
      raised_questions: outcome.raisedQuestions,
      merchant: classifyMerchant(parsed.value, events, () => getTransaction(db, outcome.transactionId)?.merchant_id),
      sides: [
        {
          side: "debit",
          requested: raw.debit_account_id,
          ...classifySide(raw.debit_account_id, "debit", events, accountExists),
        },
        {
          side: "credit",
          requested: raw.credit_account_id,
          ...classifySide(raw.credit_account_id, "credit", events, accountExists),
        },
      ],
    });
  }

  const mode = currentMode();
  if (mode.json) {
    for (const r of results) emit(r);
    emitSummary({ batch_id: batchId, posted, duplicates, failed, raised_questions: raisedTotal });
  } else {
    for (const r of results) emitObject(r);
    process.stdout.write(
      `\nbatch ${batchId}: ${posted} posted, ${duplicates} duplicate(s), ${failed} failed, ${raisedTotal} question(s) raised\n`,
    );
  }

  // Exit 7 only for genuine failures — duplicates are a successful no-op.
  if (failed > 0) process.exitCode = EXIT.PARTIAL;
}
