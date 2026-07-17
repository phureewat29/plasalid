import { randomUUID } from "crypto";
import type {
  TransactionCommitContext,
  TransactionCommitHooks,
  TransactionSide,
  RawTransactionInput,
  LinkedTransactionHeader,
  LinkedTransactionLeg,
} from "../../scanner/commit-transaction.js";
import { EXIT, currentMode, emit, emitSummary, fail, readStdinTransactions } from "../output.js";
import { emitObject, openDb } from "./ingest.js";

/**
 * `ingest commit` — the critical contract: reads an NDJSON/JSON batch of
 * extracted rows from stdin (or --input) and posts each as a transaction
 * (or a linked group) into the ledger, reporting per-row resolution detail
 * (account/merchant fuzzy-match vs. placeholder vs. exact) alongside the
 * usual ok/duplicate/failed outcome.
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

/** Wrap the default hooks so every raised question still fires (delegated to
 *  the default), while we also capture a typed event per callback to build the
 *  per-side resolution report afterwards. */
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

/**
 * Classify how an input side's account_id was resolved. Derived from the
 * captured hook events + a post-commit existence check — NOT from the stored
 * row (a duplicate re-commit fires no hooks, so absence of an event on an
 * existing account reads correctly as "exact").
 */
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
  item: any,
  events: CommitEvent[],
  resolvedMerchantId: () => string | null | undefined,
): { how: string; merchant_id?: string } {
  const hadMerchant = !!(item.merchant || item.merchant_id);
  if (!hadMerchant) return { how: "none" };
  if (events.some((e) => e.kind === "unknown_merchant")) return { how: "unknown" };
  const mid = resolvedMerchantId();
  return { how: "linked", merchant_id: mid ?? undefined };
}

export async function ingestCommit(opts: CommitOpts): Promise<void> {
  const items = await readStdinTransactions(opts.input);
  if (items.length === 0) fail("USAGE", "no transaction data provided");

  const db = await openDb();
  const { commitTransaction, commitLinkedTransactions, defaultTransactionCommitHooks } = await import(
    "../../scanner/commit-transaction.js"
  );
  const { getTransaction } = await import("../../db/queries/transactions.js");
  const { findAccountById } = await import("../../db/queries/account-balance.js");
  const { findScannedFileById } = await import("../../db/queries/files.js");
  const accountExists = (id: string): boolean => !!findAccountById(db, id);

  // ALWAYS have a scanId: defaultTransactionCommitHooks.raise() early-returns when
  // scanId is null, which silently drops every question. Minted once per invocation.
  const scanId = `sc:${randomUUID()}`;

  // Derive the deterministic-id source hash from the scanned_files row (cached).
  const fileHashCache = new Map<string, string | null>();
  const fileHashFor = (fileId: string | null): string | null => {
    if (!fileId) return null;
    if (!fileHashCache.has(fileId)) {
      fileHashCache.set(fileId, findScannedFileById(db, fileId)?.file_hash ?? null);
    }
    return fileHashCache.get(fileId) ?? null;
  };

  const results: Record<string, unknown>[] = [];
  let posted = 0;
  let duplicates = 0;
  let failed = 0;
  let raisedTotal = 0;

  for (let index = 0; index < items.length; index++) {
    const item: any = items[index];
    const fileId = (item.source_file_id ?? opts.file) ?? null;
    const ctx: TransactionCommitContext = {
      scanId,
      fileId,
      fileHash: fileHashFor(fileId),
      chunkId: null,
      progress: null,
    };
    const events: CommitEvent[] = [];
    const hooks = makeRecordingHooks(defaultTransactionCommitHooks(db, ctx), events);

    const isCompound = Array.isArray(item.linked) && item.linked.length > 0;

    if (isCompound) {
      const header: LinkedTransactionHeader = {
        date: item.date,
        description: item.description,
        raw_descriptor: item.raw_descriptor ?? null,
        source_file_id: fileId,
        source_page: item.source_page ?? null,
        merchant: item.merchant ?? null,
        merchant_id: item.merchant_id ?? null,
        group_id: item.group_id ?? null,
        row_index: item.row_index ?? null,
      };
      const legs: LinkedTransactionLeg[] = item.linked.map((l: any) => ({
        debit_account_id: l.debit_account ?? l.debit_account_id,
        credit_account_id: l.credit_account ?? l.credit_account_id,
        amount: l.amount,
        currency: l.currency ?? null,
        description: l.description,
        code: l.code ?? null,
      }));

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
        merchant: classifyMerchant(item, events, () =>
          getTransaction(db, outcome.results[0]?.id)?.merchant_id,
        ),
      });
      continue;
    }

    // Standalone transaction.
    const raw: RawTransactionInput = {
      id: item.id ?? undefined,
      date: item.date,
      description: item.description,
      raw_descriptor: item.raw_descriptor ?? null,
      source_file_id: fileId,
      source_page: item.source_page ?? null,
      row_index: item.row_index ?? null,
      merchant: item.merchant ?? null,
      merchant_id: item.merchant_id ?? null,
      debit_account_id: item.debit_account ?? item.debit_account_id,
      credit_account_id: item.credit_account ?? item.credit_account_id,
      amount: item.amount,
      currency: item.currency ?? null,
      code: item.code ?? null,
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
      merchant: classifyMerchant(item, events, () => getTransaction(db, outcome.transactionId)?.merchant_id),
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
    emitSummary({ batch_id: scanId, posted, duplicates, failed, raised_questions: raisedTotal });
  } else {
    for (const r of results) emitObject(r);
    process.stdout.write(
      `\nbatch ${scanId}: ${posted} posted, ${duplicates} duplicate(s), ${failed} failed, ${raisedTotal} question(s) raised\n`,
    );
  }

  // Exit 7 only for genuine failures — duplicates are a successful no-op.
  if (failed > 0) process.exitCode = EXIT.PARTIAL;
}
