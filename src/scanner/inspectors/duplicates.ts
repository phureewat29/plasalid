import type Database from "libsql";
import { findDuplicateTransactions, type DuplicateGroupTransaction } from "../../db/queries/transactions.js";
import { formatAmount } from "../../currency.js";
import type { RecordUnknownInput } from "../../db/queries/unknowns.js";
import type { Inspector, InspectorScope } from "./types.js";

/**
 * Surface transaction pairs that look like the same posting recorded twice.
 * One unknown is emitted per duplicate group, attached to the newest member;
 * earlier members are listed in the prompt so the user can compare side by
 * side. Only groups that include at least one transaction from this scan run
 * are surfaced — older-only groups would have been flagged on a prior run.
 *
 * Members are pruned before grouping: two transactions sharing source_file_id,
 * date, and merchant_id are almost always two real charges (the statement
 * legitimately lists Starbucks twice on the same day) and surface as noise.
 */
function inspect(db: Database.Database, scope: InspectorScope): RecordUnknownInput[] {
  if (scope.fileIds.length === 0) return [];
  const groups = findDuplicateTransactions(db);
  if (groups.length === 0) return [];

  const inScope = transactionsInScope(db, scope.fileIds);
  const out: RecordUnknownInput[] = [];

  for (const rawGroup of groups) {
    const group = dedupeSameFileSameDaySameMerchant(rawGroup);
    if (group.length < 2) continue;
    if (!group.some(g => inScope.has(g.id))) continue;

    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
    const newest = sorted[sorted.length - 1];
    const others = sorted.slice(0, -1);

    out.push({
      file_id: null,
      transaction_id: newest.id,
      account_id: null,
      kind: "duplicate",
      prompt: buildPrompt(newest, others),
      options: ["Delete this one", "Delete the older one", "Keep both", "Skip"],
    });
  }
  return out;
}

/**
 * Collapse same-file, same-date, same-merchant transactions to a single
 * representative so they don't trigger a "duplicate" unknown between
 * themselves. (Across files or across dates is still flagged.)
 */
function dedupeSameFileSameDaySameMerchant(group: DuplicateGroupTransaction[]): DuplicateGroupTransaction[] {
  const seen = new Map<string, DuplicateGroupTransaction>();
  for (const tx of group) {
    if (tx.source_file_id == null) { seen.set(tx.id, tx); continue; }
    const key = `${tx.source_file_id}|${tx.date}|${tx.merchant_id ?? ""}`;
    if (!seen.has(key)) seen.set(key, tx);
  }
  return Array.from(seen.values());
}

function buildPrompt(newest: DuplicateGroupTransaction, others: DuplicateGroupTransaction[]): string {
  const amount = formatAmount(newest.amount);
  const lines = [
    `${amount} on ${newest.date} (${newest.description}) — accounts: ${newest.account_names.join(", ")}`,
    ...others.map(o => `  matches ${o.date} (${o.description}) — accounts: ${o.account_names.join(", ")}`),
  ];
  return `Possible duplicate transaction.\n${lines.join("\n")}`;
}

function transactionsInScope(db: Database.Database, fileIds: readonly string[]): Set<string> {
  const placeholders = fileIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id FROM transactions WHERE source_file_id IN (${placeholders})`)
    .all(...fileIds) as { id: string }[];
  return new Set(rows.map(r => r.id));
}

export const duplicatesInspector: Inspector = { name: "duplicates", inspect };
