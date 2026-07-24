import type Database from "libsql";
import type {
  TransactionCommitContext,
  TransactionCommitHooks,
  TransactionSide,
  RawTransactionInput,
  LinkedTransactionHeader,
  LinkedTransactionLeg,
} from "../../ingest/commit-transaction.js";
import { EXIT, asRecord, currentMode, emit, emitObject, emitSummary, fail, readStdinBatch } from "../output.js";
import { openDb } from "../db.js";
import { newBatchId } from "../../lib/ids.js";
import * as z from "zod";
import { safeParse, str, num, json } from "../../lib/validate.js";
import type { MerchantUpsertInput } from "../../db/queries/merchants.js";

/**
 * `ingest commit`: reads an NDJSON/JSON batch from stdin (or --input) and
 * posts each row as a transaction (or linked group), reporting per-row
 * resolution detail (fuzzy-match vs. placeholder vs. exact) alongside ok/duplicate/failed.
 */

interface CommitIngestOpts {
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

interface Counters {
  posted: number;
  duplicates: number;
  failed: number;
  raisedTotal: number;
}

// Per-invocation collaborators resolved once (dynamic imports, db, derived
// helpers) and shared by every row. Passed explicitly so the row committers
// capture no loop-scoped state.
interface RowCommitDeps {
  db: Database.Database;
  commitTransaction: (typeof import("../../ingest/commit-transaction.js"))["commitTransaction"];
  commitLinkedTransactions: (typeof import("../../ingest/commit-transaction.js"))["commitLinkedTransactions"];
  getTransaction: (typeof import("../../db/queries/transactions.js"))["getTransaction"];
  accountExists: (id: string) => boolean;
  counters: Counters;
}

// The per-row state built before the compound/standalone split.
interface RowContext {
  record: Record<string, unknown>;
  index: number;
  fileId: string | null;
  ctx: TransactionCommitContext;
  events: CommitEvent[];
  hooks: TransactionCommitHooks;
}

// Derive the deterministic-id source hash from the files row, memoized per file.
function makeFileHashCache(
  db: Database.Database,
  findFileById: (typeof import("../../db/queries/files.js"))["findFileById"],
): (fileId: string | null) => string | null {
  const cache = new Map<string, string | null>();
  return (fileId) => {
    if (!fileId) return null;
    if (!cache.has(fileId)) cache.set(fileId, findFileById(db, fileId)?.file_hash ?? null);
    return cache.get(fileId) ?? null;
  };
}

// A row rejected before the commit pipeline (bad JSON shape) reuses the per-row
// failure shape so the PARTIAL contract holds. Counts the failure and returns
// the record for the caller to push — never throws.
function failRow(counters: Counters, index: number, message: string): Record<string, unknown> {
  counters.failed++;
  return { type: "result", index, ok: false, reason: "dirty_input", message, raised_questions: 0 };
}

// Compound row: a header plus >=1 linked legs committed atomically under one group.
function commitCompoundRow(
  deps: RowCommitDeps,
  row: RowContext,
  linked: unknown[],
): Record<string, unknown> {
  const { counters } = deps;
  const parsedHeader = safeParse(LINKED_HEADER_SPEC, row.record);
  if (!parsedHeader.ok) return failRow(counters, row.index, parsedHeader.error);
  const header: LinkedTransactionHeader = { ...parsedHeader.value, source_file_id: row.fileId };

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
  if (legError !== undefined) return failRow(counters, row.index, legError);

  const outcome = deps.commitLinkedTransactions(deps.db, row.ctx, header, legs, row.hooks);
  counters.raisedTotal += outcome.raisedQuestions;

  if (!outcome.ok) {
    counters.failed++;
    return {
      type: "result",
      index: row.index,
      ok: false,
      reason: outcome.reason,
      message: outcome.message,
      raised_questions: outcome.raisedQuestions,
    };
  }

  const allDuplicate = outcome.results.every((r) => r.duplicate);
  if (allDuplicate) counters.duplicates++;
  else counters.posted++;

  return {
    type: "result",
    index: row.index,
    ok: true,
    group_id: outcome.group_id,
    legs: outcome.results.map((r) => ({ transaction_id: r.id, duplicate: r.duplicate })),
    duplicate: allDuplicate,
    raised_questions: outcome.raisedQuestions,
    merchant: classifyMerchant(parsedHeader.value, row.events, () =>
      deps.getTransaction(deps.db, outcome.results[0]?.id)?.merchant_id,
    ),
  };
}

// Standalone row: a single debit/credit transaction.
function commitStandaloneRow(deps: RowCommitDeps, row: RowContext): Record<string, unknown> {
  const { counters } = deps;
  const parsed = safeParse(STANDALONE_SPEC, row.record, { aliases: LEG_ALIASES });
  if (!parsed.ok) return failRow(counters, row.index, parsed.error);
  // Cast is a lie for malformed rows — validateRawTransaction rejects those.
  const raw: RawTransactionInput = {
    ...parsed.value,
    source_file_id: row.fileId,
    amount: row.record.amount as number,
  };

  const outcome = deps.commitTransaction(deps.db, row.ctx, raw, row.hooks);
  counters.raisedTotal += outcome.raisedQuestions;

  if (!outcome.ok) {
    counters.failed++;
    return {
      type: "result",
      index: row.index,
      ok: false,
      reason: outcome.reason,
      message: outcome.message,
      raised_questions: outcome.raisedQuestions,
    };
  }

  if (outcome.duplicate) counters.duplicates++;
  else counters.posted++;

  return {
    type: "result",
    index: row.index,
    ok: true,
    transaction_id: outcome.transactionId,
    duplicate: outcome.duplicate,
    raised_questions: outcome.raisedQuestions,
    merchant: classifyMerchant(parsed.value, row.events, () =>
      deps.getTransaction(deps.db, outcome.transactionId)?.merchant_id,
    ),
    sides: [
      {
        side: "debit",
        requested: raw.debit_account_id,
        ...classifySide(raw.debit_account_id, "debit", row.events, deps.accountExists),
      },
      {
        side: "credit",
        requested: raw.credit_account_id,
        ...classifySide(raw.credit_account_id, "credit", row.events, deps.accountExists),
      },
    ],
  };
}

export async function commitIngest(opts: CommitIngestOpts): Promise<void> {
  const items = await readStdinBatch(opts.input);
  if (items.length === 0) fail("USAGE", "no transaction data provided");

  const db = await openDb();
  const { commitTransaction, commitLinkedTransactions, defaultTransactionCommitHooks } = await import(
    "../../ingest/commit-transaction.js"
  );
  const { getTransaction } = await import("../../db/queries/transactions.js");
  const { findAccountById } = await import("../../accounts/accounts.js");
  const { findFileById } = await import("../../db/queries/files.js");
  const accountExists = (id: string): boolean => !!findAccountById(db, id);

  // Must be non-null: raise() no-ops when batchId is null, silently dropping every question.
  const batchId = newBatchId();
  const fileHashFor = makeFileHashCache(db, findFileById);

  const counters: Counters = { posted: 0, duplicates: 0, failed: 0, raisedTotal: 0 };
  const deps: RowCommitDeps = {
    db,
    commitTransaction,
    commitLinkedTransactions,
    getTransaction,
    accountExists,
    counters,
  };

  const results: Record<string, unknown>[] = [];

  for (let index = 0; index < items.length; index++) {
    const record = asRecord(items[index]);
    if (!record) {
      results.push(failRow(counters, index, "each transaction must be a JSON object."));
      continue;
    }

    const fileId = ((record.source_file_id as string | null | undefined) ?? opts.file) ?? null;
    const ctx: TransactionCommitContext = { batchId, fileId, fileHash: fileHashFor(fileId) };
    const events: CommitEvent[] = [];
    const hooks = makeRecordingHooks(defaultTransactionCommitHooks(db, ctx), events);
    const row: RowContext = { record, index, fileId, ctx, events, hooks };

    const linked = record.linked;
    if (Array.isArray(linked) && linked.length > 0) {
      results.push(commitCompoundRow(deps, row, linked));
      continue;
    }
    results.push(commitStandaloneRow(deps, row));
  }

  const mode = currentMode();
  if (mode.json) {
    for (const r of results) emit(r);
    emitSummary({
      batch_id: batchId,
      posted: counters.posted,
      duplicates: counters.duplicates,
      failed: counters.failed,
      raised_questions: counters.raisedTotal,
    });
  } else {
    for (const r of results) emitObject(r);
    process.stdout.write(
      `\nbatch ${batchId}: ${counters.posted} posted, ${counters.duplicates} duplicate(s), ${counters.failed} failed, ${counters.raisedTotal} question(s) raised\n`,
    );
  }

  // Exit 7 only for genuine failures — duplicates are a successful no-op.
  if (counters.failed > 0) process.exitCode = EXIT.PARTIAL;
}
