import type Database from "libsql";
import { findCorrelatedTransactions, type CorrelatedTransactionPair } from "../../db/queries/transactions.js";
import { formatAmount } from "../../currency.js";
import type { RecordUnknownInput } from "../../db/queries/unknowns.js";
import type { Inspector, InspectorScope } from "./types.js";

/**
 * Cross-account correlation: a single money movement that landed on two
 * different accounts (e.g. transfer from bank to card recorded once per
 * statement). One unknown per pair, attached to the newer side. Only pairs
 * with at least one side in `fileIds` are surfaced.
 */
function inspect(db: Database.Database, scope: InspectorScope): RecordUnknownInput[] {
  if (scope.fileIds.length === 0) return [];
  const pairs = findCorrelatedTransactions(db);
  if (pairs.length === 0) return [];

  const inScope = transactionsInScope(db, scope.fileIds);
  const out: RecordUnknownInput[] = [];

  for (const pair of pairs) {
    if (!inScope.has(pair.a.id) && !inScope.has(pair.b.id)) continue;
    const [older, newer] = pair.a.date <= pair.b.date ? [pair.a, pair.b] : [pair.b, pair.a];
    out.push({
      file_id: null,
      transaction_id: newer.id,
      account_id: null,
      kind: "correlation",
      prompt: buildPrompt(pair, older, newer),
      options: ["Merge into one transaction", "Keep separate (these are two real events)", "Skip"],
    });
  }
  return out;
}

function buildPrompt(
  pair: CorrelatedTransactionPair,
  older: CorrelatedTransactionPair["a"],
  newer: CorrelatedTransactionPair["a"],
): string {
  const amount = formatAmount(pair.amount, pair.currency);
  return [
    `Possible cross-account correlation (${amount}, ${pair.day_gap} day(s) apart).`,
    `  ${newer.date} — ${newer.description} — ${newer.account_names.join(", ")}`,
    `  ${older.date} — ${older.description} — ${older.account_names.join(", ")}`,
  ].join("\n");
}

function transactionsInScope(db: Database.Database, fileIds: readonly string[]): Set<string> {
  const placeholders = fileIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id FROM transactions WHERE source_file_id IN (${placeholders})`)
    .all(...fileIds) as { id: string }[];
  return new Set(rows.map(r => r.id));
}

export const correlationsInspector: Inspector = { name: "correlations", inspect };
