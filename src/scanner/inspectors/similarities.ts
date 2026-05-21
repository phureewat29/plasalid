import type Database from "libsql";
import { findSimilarAccounts } from "../../db/queries/account-balance.js";
import type { RecordUnknownInput } from "../../db/queries/unknowns.js";
import type { Inspector, InspectorScope } from "./types.js";

/**
 * Flag pairs of accounts whose names are near-identical (Levenshtein ≥ 0.85).
 * Runs whenever a scan committed at least one transaction — the assumption is
 * that the scanner may have created a new account this run, so it's worth a
 * fresh similarity sweep. Idempotent against existing open unknowns: a pair
 * already flagged is not flagged again. The resolver applies "Merge A into B"
 * via merge_accounts.
 */
function inspect(
  db: Database.Database,
  scope: InspectorScope,
): RecordUnknownInput[] {
  if (scope.fileIds.length === 0) return [];
  const pairs = findSimilarAccounts(db);
  if (pairs.length === 0) return [];

  const alreadyFlagged = loadAlreadyFlaggedAccountPairs(db);
  const out: RecordUnknownInput[] = [];

  for (const pair of pairs) {
    const key = pairKey(pair.a.id, pair.b.id);
    if (alreadyFlagged.has(key)) continue;

    out.push({
      file_id: null,
      transaction_id: null,
      account_id: pair.a.id,
      kind: "similar_accounts",
      prompt: `These two accounts look like the same thing:\n  ${pair.a.name}\n  ${pair.b.name}`,
      options: [
        `Merge ${pair.b.name} into ${pair.a.name}`,
        `Merge ${pair.a.name} into ${pair.b.name}`,
        "Keep separate",
        "Skip",
      ],
      context: { otherAccountId: pair.b.id },
    });
  }
  return out;
}

/**
 * `similar_accounts` unknowns store the partner account id in `context_json`
 * (`{otherAccountId}`); the row's own `account_id` is one half of the pair.
 * Read both to skip pairs the user has already seen — including ones answered
 * "Keep separate" on a prior run.
 */
function loadAlreadyFlaggedAccountPairs(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      `SELECT account_id, context_json FROM unknowns
       WHERE kind = 'similar_accounts' AND account_id IS NOT NULL`,
    )
    .all() as { account_id: string; context_json: string | null }[];
  const out = new Set<string>();
  for (const row of rows) {
    if (!row.context_json) continue;
    try {
      const ctx = JSON.parse(row.context_json) as { otherAccountId?: string };
      if (ctx.otherAccountId) out.add(pairKey(row.account_id, ctx.otherAccountId));
    } catch {
      // skip malformed context_json
    }
  }
  return out;
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

export const similarAccountsInspector: Inspector = {
  name: "similar_accounts",
  inspect,
};
