import type Database from "libsql";
import {
  createAccount,
  findAccountById,
  ensureStructuralAccount,
  ensureTopLevelRoot,
} from "./accounts.js";
import { TOP_LEVEL_TYPES, type AccountType } from "./types.js";
import { findAccountsByFuzzyName } from "./matching.js";

// Shared account/merchant resolution used by the commit pipeline (`commit-transaction.ts`).

export interface ResolvedMerchant {
  readonly merchantId: string | null;
  readonly attemptedUnknownId: string | null;
}

export type AccountHint =
  | { readonly type: "placeholder_created"; readonly accountId: string }
  | { readonly type: "uncategorized_fallback"; readonly accountId: string }
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

interface ResolveOnePostingOptions {
  /** Skip fuzzy-match and go straight to placeholder/fallback. Used by the
   *  commit pipeline's fuzzy-collapse guard to re-resolve a side without
   *  repeating the fuzzy match that caused the collapse. */
  skipFuzzy?: boolean;
}

/**
 * Resolves one account reference: exact match, then fuzzy (score >= 0.7,
 * unless `skipFuzzy`), then a placeholder for a well-formed multi-segment
 * path, else the `expense:uncategorized` fallback. `hint` is null on exact
 * match; `uncategorized_fallback` is the ambiguous case the commit pipeline
 * turns into a question.
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
  const placeholder = ensurePlaceholderAccount(db, posting.account_id);
  return {
    posting: { ...posting, account_id: placeholder.accountId },
    hint: placeholder.fellBack
      ? { type: "uncategorized_fallback", accountId: placeholder.accountId }
      : { type: "placeholder_created", accountId: placeholder.accountId },
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
 * Walks `segments` from the root down through index `upTo` (1-based),
 * creating any missing account with a humanized placeholder name. Returns
 * ids actually created, root-to-leaf. `ACCOUNT_EXISTS` races are swallowed
 * as a no-op; every other error propagates to the caller.
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

interface PlaceholderResult {
  /** The resolved account id: the requested path when it was created, else
   *  `expense:uncategorized`. */
  accountId: string;
  /** True when the path couldn't be built (bad id, unknown type, or a
   *  hierarchy error) and resolution fell back to `expense:uncategorized`.
   *  The commit pipeline turns a fallback into a question. */
  fellBack: boolean;
}

/**
 * Best-effort placeholder resolution: creates the account and every missing
 * ancestor when the id is a well-formed multi-segment path under a known
 * top-level type, else falls back to `expense:uncategorized`. Always returns
 * a usable id rather than surfacing an error.
 */
function ensurePlaceholderAccount(db: Database.Database, accountId: string): PlaceholderResult {
  const segments = accountId.split(":").filter(Boolean);
  if (segments.length < 2) return { accountId: ensureUncategorizedFallback(db), fellBack: true };

  const type = segments[0] as AccountType;
  if (!TOP_LEVEL_TYPES.includes(type)) return { accountId: ensureUncategorizedFallback(db), fellBack: true };

  // Intentional swallow: any hierarchy failure (unknown type, malformed id, a
  // create race) degrades to the uncategorized fallback per this function's
  // contract — a usable id is always returned, never a surfaced error.
  // `--resolve` relies on this to auto-create a placeholder silently.
  try {
    walkAncestorChain(db, segments, type, segments.length);
  } catch {
    return { accountId: ensureUncategorizedFallback(db), fellBack: true };
  }
  return { accountId, fellBack: false };
}

interface EnsureAccountAncestorsResult {
  /** The immediate parent id the leaf should be created under, or null for a
   *  single-segment id (a bare top-level root — nothing to auto-create). */
  parentId: string | null;
  /** Ancestor ids created as a side effect, root-to-leaf order; empty when
   *  every ancestor along the chain already existed. */
  createdParents: string[];
}

/**
 * For a multi-segment id about to be created (e.g. `asset:bank:ttb`), creates
 * any missing ancestor above the leaf. Used by `accounts create` so a deep id
 * doesn't require pre-creating every intermediate category. Unlike
 * `ensurePlaceholderAccount`, propagates hierarchy errors as-is (no
 * `expense:uncategorized` fallback) so the CLI can surface a real INVALID.
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
