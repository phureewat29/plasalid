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
      prompt: `These two accounts look like the same thing (similarity ${pair.similarity}):\n  ${pair.a.id} — ${pair.a.name}\n  ${pair.b.id} — ${pair.b.name}`,
      options: [
        `Merge ${pair.b.id} into ${pair.a.id}`,
        `Merge ${pair.a.id} into ${pair.b.id}`,
        "Keep separate",
        "Skip",
      ],
    });
  }
  return out;
}

/**
 * `similar_accounts` unknowns (open OR resolved) embed the other account's id
 * in their options strings ("Merge X into Y"). Parse those out so we don't
 * re-flag a pair the user has already seen — including pairs they've already
 * answered "Keep separate" on a prior run.
 */
function loadAlreadyFlaggedAccountPairs(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      `SELECT account_id, options_json FROM unknowns
       WHERE kind = 'similar_accounts' AND account_id IS NOT NULL`,
    )
    .all() as { account_id: string; options_json: string | null }[];
  const out = new Set<string>();
  for (const row of rows) {
    if (!row.options_json) continue;
    try {
      const options = JSON.parse(row.options_json) as string[];
      for (const opt of options) {
        const match = opt.match(/Merge (\S+) into (\S+)/);
        if (match) out.add(pairKey(match[1], match[2]));
      }
    } catch {
      // skip malformed options_json
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
