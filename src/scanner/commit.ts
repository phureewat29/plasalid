import type Database from "libsql";
import {
  validateTransaction,
  insertTransactionRows,
  type TransactionInput,
  type PostingInput,
} from "../db/queries/transactions.js";
import {
  createAccount,
  findAccountById,
  findAccountsByFuzzyName,
  ensureStructuralAccount,
  ensureTopLevelRoot,
  TOP_LEVEL_TYPES,
  type AccountType,
} from "../db/queries/account-balance.js";
import { recordQuestion } from "../db/queries/questions.js";

const NON_WORD = /[^\p{L}\p{N}]+/gu;

function normalizeDescriptor(raw: string): string {
  return raw.toLowerCase().replace(NON_WORD, " ").replace(/\s+/g, " ").trim();
}

function descriptorKey(descriptor: string): string {
  return `descriptor:${normalizeDescriptor(descriptor)}`;
}

function accountPairKey(a: string, b: string): string {
  const [lo, hi] = [a, b].sort();
  return `account-pair:${lo}|${hi}`;
}

function accountIdKey(id: string): string {
  return `account:${id}`;
}

export interface CommitContext {
  readonly scanId: string | null;
  readonly fileId: string | null;
  readonly chunkId: string | null;
  readonly progress: ProgressEmitter | null;
}

export interface ProgressEmitter {
  emit(event: { chunkId: string; kind: "tx" | "question" }): void;
}

export type CommitOutcome =
  | { ok: true; transactionId: string; raisedQuestions: number }
  | { ok: false; reason: DropReason; message: string; raisedQuestions: number };

export type DropReason = "dirty_input";

export interface CommitHooks {
  onCommitted(transactionId: string): void;
  onDirtyInput(input: TransactionInput, reason: string): void;
  onUnknownMerchant(
    input: TransactionInput,
    transactionId: string,
    attemptedId: string,
  ): void;
  onPlaceholderAccount(accountId: string, transactionId: string): void;
  onSimilarAccount(
    originalId: string,
    matchedId: string,
    transactionId: string,
  ): void;
}

interface ValidationOk {
  readonly ok: true;
  readonly validated: TransactionInput & { id: string };
}
interface ValidationFail {
  readonly ok: false;
  readonly reason: string;
}
type ValidationResult = ValidationOk | ValidationFail;

interface ResolvedMerchant {
  readonly merchantId: string | null;
  readonly attemptedUnknownId: string | null;
}

type AccountHint =
  | { readonly type: "placeholder_created"; readonly accountId: string }
  | {
      readonly type: "similar_matched";
      readonly originalId: string;
      readonly matchedId: string;
    };

interface ResolvedAccounts {
  readonly postings: PostingInput[];
  readonly hints: AccountHint[];
}

export function defaultCommitHooks(
  db: Database.Database,
  ctx: CommitContext,
): CommitHooks {
  const tick = (kind: "tx" | "question"): void => {
    if (ctx.progress && ctx.chunkId)
      ctx.progress.emit({ chunkId: ctx.chunkId, kind });
  };
  const raise = (
    input: Omit<Parameters<typeof recordQuestion>[1], "file_id" | "scan_id">,
  ): void => {
    if (!ctx.scanId) return;
    recordQuestion(db, { ...input, file_id: ctx.fileId, scan_id: ctx.scanId });
    tick("question");
  };

  return {
    onCommitted: () => tick("tx"),

    onDirtyInput: (input, reason) =>
      raise({
        transaction_id: null,
        account_id: null,
        kind: "dirty_input",
        prompt:
          `The scanner returned a row that couldn't be validated: ${reason}. ` +
          `Raw description: "${input.description}" on ${input.date}.`,
        context: { description: input.description, date: input.date, reason },
      }),

    onUnknownMerchant: (input, transactionId, attemptedId) => {
      const descriptor = input.raw_descriptor || input.description;
      raise({
        transaction_id: transactionId,
        account_id: null,
        kind: "unknown_merchant",
        prompt:
          `The scanner referenced merchant id "${attemptedId}" but no such merchant exists. ` +
          `Link "${descriptor}" to an existing merchant or leave it unlinked.`,
        context: {
          rule_key: descriptorKey(descriptor),
          descriptor,
          attempted_id: attemptedId,
        },
      });
    },

    onPlaceholderAccount: (accountId, transactionId) =>
      raise({
        transaction_id: transactionId,
        account_id: accountId,
        kind: "uncategorized",
        prompt:
          `A placeholder account was created for posting "${accountId}". ` +
          `Confirm the category, merge into an existing account, or rename.`,
        context: {
          rule_key: accountIdKey(accountId),
          placeholder_id: accountId,
        },
      }),

    onSimilarAccount: (originalId, matchedId, transactionId) =>
      raise({
        transaction_id: transactionId,
        account_id: matchedId,
        kind: "similar_accounts",
        prompt:
          `The scanner referenced "${originalId}" — the closest existing account is "${matchedId}". ` +
          `Confirm they are the same, or split them apart.`,
        context: {
          rule_key: accountPairKey(originalId, matchedId),
          original_id: originalId,
          matched_id: matchedId,
        },
      }),
  };
}

export function commitTransaction(
  db: Database.Database,
  ctx: CommitContext,
  input: TransactionInput,
  hooks: CommitHooks = defaultCommitHooks(db, ctx),
): CommitOutcome {
  const validation = stageValidate(input);
  if (!validation.ok) {
    hooks.onDirtyInput(input, validation.reason);
    return {
      ok: false,
      reason: "dirty_input",
      message: validation.reason,
      raisedQuestions: 1,
    };
  }

  const merchant = stageResolveMerchant(db, validation.validated);
  const accounts = stageResolveAccounts(db, validation.validated);

  const committed = {
    ...validation.validated,
    merchant_id: merchant.merchantId,
    postings: accounts.postings,
  };
  const tx = db.transaction((): void => insertTransactionRows(db, committed));
  tx();
  hooks.onCommitted(committed.id);

  const raised = applyHints({
    hooks,
    transactionId: committed.id,
    merchant,
    accounts,
    input,
  });
  return { ok: true, transactionId: committed.id, raisedQuestions: raised };
}

function stageValidate(input: TransactionInput): ValidationResult {
  try {
    return { ok: true, validated: validateTransaction(input) };
  } catch (err: any) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}

function stageResolveMerchant(
  db: Database.Database,
  input: TransactionInput & { id: string },
): ResolvedMerchant {
  if (!input.merchant_id) return { merchantId: null, attemptedUnknownId: null };
  const exists = db
    .prepare(`SELECT 1 FROM merchants WHERE id = ?`)
    .get(input.merchant_id);
  if (exists)
    return { merchantId: input.merchant_id, attemptedUnknownId: null };
  return { merchantId: null, attemptedUnknownId: input.merchant_id };
}

function stageResolveAccounts(
  db: Database.Database,
  input: TransactionInput & { id: string },
): ResolvedAccounts {
  const postings: PostingInput[] = [];
  const hints: AccountHint[] = [];
  for (const p of input.postings) {
    const resolved = resolveOnePosting(db, p);
    postings.push(resolved.posting);
    if (resolved.hint) hints.push(resolved.hint);
  }
  return { postings, hints };
}

function resolveOnePosting(
  db: Database.Database,
  posting: PostingInput,
): { posting: PostingInput; hint: AccountHint | null } {
  if (findAccountById(db, posting.account_id)) {
    return { posting, hint: null };
  }
  const matched = bestFuzzyMatch(db, posting.account_id);
  if (matched) {
    return {
      posting: { ...posting, account_id: matched },
      hint: {
        type: "similar_matched",
        originalId: posting.account_id,
        matchedId: matched,
      },
    };
  }
  const placeholderId = ensurePlaceholderAccount(db, posting.account_id);
  return {
    posting: { ...posting, account_id: placeholderId },
    hint: { type: "placeholder_created", accountId: placeholderId },
  };
}

const FUZZY_THRESHOLD = 0.7;

function bestFuzzyMatch(
  db: Database.Database,
  accountId: string,
): string | null {
  const leaf = leafSegment(accountId).replace(/[-_]+/g, " ");
  if (!leaf) return null;
  const matches = findAccountsByFuzzyName(db, leaf, FUZZY_THRESHOLD);
  return matches[0]?.account.id ?? null;
}

function leafSegment(id: string): string {
  const segments = id.split(":");
  return segments[segments.length - 1] ?? id;
}

// Falls back to expense:uncategorized when the top-level segment isn't a known account type.
function ensurePlaceholderAccount(
  db: Database.Database,
  accountId: string,
): string {
  const segments = accountId.split(":").filter(Boolean);
  if (segments.length === 0) return ensureUncategorizedFallback(db);

  const type = segments[0] as AccountType;
  if (!TOP_LEVEL_TYPES.includes(type)) return ensureUncategorizedFallback(db);

  ensureTopLevelRoot(db, type);
  for (let i = 2; i <= segments.length; i++) {
    const id = segments.slice(0, i).join(":");
    if (findAccountById(db, id)) continue;
    const parentId = i === 1 ? null : segments.slice(0, i - 1).join(":");
    const name = humanizeSegment(segments[i - 1]);
    try {
      createAccount(db, { id, name, type, parent_id: parentId });
    } catch (err: any) {
      if (err?.code === "ACCOUNT_EXISTS") continue;
      return ensureUncategorizedFallback(db);
    }
  }
  return accountId;
}

function ensureUncategorizedFallback(db: Database.Database): string {
  ensureStructuralAccount(db, "expense:uncategorized");
  return "expense:uncategorized";
}

function humanizeSegment(segment: string): string {
  const spaced = segment.replace(/[-_]+/g, " ").trim();
  if (!spaced) return "Placeholder";
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
}

function applyHints(args: {
  hooks: CommitHooks;
  transactionId: string;
  merchant: ResolvedMerchant;
  accounts: ResolvedAccounts;
  input: TransactionInput;
}): number {
  let raised = 0;
  if (args.merchant.attemptedUnknownId) {
    args.hooks.onUnknownMerchant(
      args.input,
      args.transactionId,
      args.merchant.attemptedUnknownId,
    );
    raised++;
  }
  for (const hint of args.accounts.hints) {
    dispatchHint(hint, args.hooks, args.transactionId);
    raised++;
  }
  return raised;
}

function dispatchHint(
  hint: AccountHint,
  hooks: CommitHooks,
  transactionId: string,
): void {
  switch (hint.type) {
    case "placeholder_created":
      hooks.onPlaceholderAccount(hint.accountId, transactionId);
      return;
    case "similar_matched":
      hooks.onSimilarAccount(hint.originalId, hint.matchedId, transactionId);
      return;
  }
}
