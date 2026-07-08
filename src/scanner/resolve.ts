import type Database from "libsql";
import {
  createAccount,
  findAccountById,
  findAccountsByFuzzyName,
  ensureStructuralAccount,
  ensureTopLevelRoot,
  TOP_LEVEL_TYPES,
  type AccountType,
} from "../db/queries/account-balance.js";

/**
 * Shared account/merchant resolution used by the commit pipeline
 * (`commit-transaction.ts`). Relocated here from the deleted `commit.ts` so the
 * transaction core owns it directly — no posting-model dependency remains.
 */

export interface ProgressEmitter {
  emit(event: { chunkId: string; kind: "tx" | "question" }): void;
}

export interface ResolvedMerchant {
  readonly merchantId: string | null;
  readonly attemptedUnknownId: string | null;
}

export type AccountHint =
  | { readonly type: "placeholder_created"; readonly accountId: string }
  | {
      readonly type: "similar_matched";
      readonly originalId: string;
      readonly matchedId: string;
    };

/**
 * Resolve a (possibly null) merchant id: returns it when the merchant exists,
 * or records it as an attempted-unknown so the caller can raise a question.
 */
export function resolveMerchantId(
  db: Database.Database,
  merchantId: string | null | undefined,
): ResolvedMerchant {
  if (!merchantId) return { merchantId: null, attemptedUnknownId: null };
  const exists = db.prepare(`SELECT 1 FROM merchants WHERE id = ?`).get(merchantId);
  if (exists) return { merchantId, attemptedUnknownId: null };
  return { merchantId: null, attemptedUnknownId: merchantId };
}

export interface ResolveOnePostingOptions {
  /**
   * Skip the fuzzy-match stage and go straight to placeholder creation (or
   * the uncategorized fallback) after an exact match misses. Used by the
   * commit pipeline's fuzzy-collapse guard to re-resolve a side that fuzzy-
   * matched onto the other side's account, without repeating the same fuzzy
   * match.
   */
  skipFuzzy?: boolean;
}

/**
 * Resolve one account reference: exact match, then fuzzy (score >= 0.7,
 * unless `skipFuzzy`), then a freshly created placeholder account, then the
 * `expense:uncategorized` fallback. Returns the input shape with its
 * `account_id` rewritten to the resolved id, plus a hint describing any
 * non-exact resolution.
 */
export function resolveOnePosting<T extends { account_id: string }>(
  db: Database.Database,
  posting: T,
  opts: ResolveOnePostingOptions = {},
): { posting: T; hint: AccountHint | null } {
  if (findAccountById(db, posting.account_id)) {
    return { posting, hint: null };
  }
  if (!opts.skipFuzzy) {
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
  }
  const placeholderId = ensurePlaceholderAccount(db, posting.account_id);
  return {
    posting: { ...posting, account_id: placeholderId },
    hint: { type: "placeholder_created", accountId: placeholderId },
  };
}

const FUZZY_THRESHOLD = 0.7;

function bestFuzzyMatch(db: Database.Database, accountId: string): string | null {
  const leaf = leafSegment(accountId).replace(/[-_]+/g, " ");
  if (!leaf) return null;
  const matches = findAccountsByFuzzyName(db, leaf, FUZZY_THRESHOLD);
  return matches[0]?.account.id ?? null;
}

function leafSegment(id: string): string {
  const segments = id.split(":");
  return segments[segments.length - 1] ?? id;
}

/**
 * Walk `segments` from the top-level root down to and including index
 * `upTo` (1-based; `upTo === segments.length` reaches the leaf), creating any
 * account row that doesn't yet exist with a humanized placeholder name of
 * the shared `type`. Returns the ids actually created, in root-to-leaf
 * order (existing rows are skipped, not reported). `ACCOUNT_EXISTS` races are
 * swallowed as a no-op; every other error propagates to the caller, which
 * decides whether that's fatal or worth a soft fallback.
 */
function walkAncestorChain(
  db: Database.Database,
  segments: string[],
  type: AccountType,
  upTo: number,
): string[] {
  const created: string[] = [];
  if (!findAccountById(db, type)) created.push(type);
  ensureTopLevelRoot(db, type);
  for (let i = 2; i <= upTo; i++) {
    const id = segments.slice(0, i).join(":");
    if (findAccountById(db, id)) continue;
    const parentId = segments.slice(0, i - 1).join(":");
    const name = humanizeSegment(segments[i - 1]);
    try {
      createAccount(db, { id, name, type, parent_id: parentId });
      created.push(id);
    } catch (err: any) {
      if (err?.code === "ACCOUNT_EXISTS") continue;
      throw err;
    }
  }
  return created;
}

// Falls back to expense:uncategorized when the top-level segment isn't a
// known account type, or when the chain walk hits a genuine hierarchy error
// (e.g. a type mismatch against an existing ancestor) — this is the ingest
// pipeline's best-effort resolution, so it always returns SOME usable id
// rather than surfacing the error.
function ensurePlaceholderAccount(db: Database.Database, accountId: string): string {
  const segments = accountId.split(":").filter(Boolean);
  if (segments.length === 0) return ensureUncategorizedFallback(db);

  const type = segments[0] as AccountType;
  if (!TOP_LEVEL_TYPES.includes(type)) return ensureUncategorizedFallback(db);

  try {
    walkAncestorChain(db, segments, type, segments.length);
  } catch {
    return ensureUncategorizedFallback(db);
  }
  return accountId;
}

export interface EnsureAccountAncestorsResult {
  /** The immediate parent id the leaf should be created under, or null for a
   *  single-segment id (a bare top-level root — nothing to auto-create). */
  parentId: string | null;
  /** Ancestor ids created as a side effect, root-to-leaf order; empty when
   *  every ancestor along the chain already existed. */
  createdParents: string[];
}

/**
 * For a multi-segment account id about to be created (e.g. `asset:bank:ttb`),
 * walk from the top-level root down to (but excluding) the leaf segment,
 * creating any missing ancestor with a humanized placeholder name of the
 * given `type`. Used by `accounts create` when the caller didn't pass an
 * explicit `--parent`, so a deep id doesn't require pre-creating every
 * intermediate category by hand.
 *
 * Unlike `ensurePlaceholderAccount` above (the ingest pipeline's best-effort
 * resolution, which swallows a genuine hierarchy error into the
 * `expense:uncategorized` fallback), this propagates errors as-is so
 * `accounts create` can surface a real INVALID failure — e.g. a type
 * mismatch against an existing ancestor.
 */
export function ensureAccountAncestors(
  db: Database.Database,
  id: string,
  type: AccountType,
): EnsureAccountAncestorsResult {
  const segments = id.split(":").filter(Boolean);
  if (segments.length < 2) return { parentId: null, createdParents: [] };

  const createdParents = walkAncestorChain(db, segments, type, segments.length - 1);
  const parentId = segments.slice(0, segments.length - 1).join(":");
  return { parentId, createdParents };
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
