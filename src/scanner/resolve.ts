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
 * (`commit-transfer.ts`). Relocated here from the deleted `commit.ts` so the
 * transfer core owns it directly — no posting-model dependency remains.
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

/**
 * Resolve one account reference: exact match, then fuzzy (score >= 0.7), then a
 * freshly created placeholder account, then the `expense:uncategorized`
 * fallback. Returns the input shape with its `account_id` rewritten to the
 * resolved id, plus a hint describing any non-exact resolution.
 */
export function resolveOnePosting<T extends { account_id: string }>(
  db: Database.Database,
  posting: T,
): { posting: T; hint: AccountHint | null } {
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

// Falls back to expense:uncategorized when the top-level segment isn't a known account type.
function ensurePlaceholderAccount(db: Database.Database, accountId: string): string {
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
