import type Database from "libsql";
import { findRecurrenceCandidates, type RecurrenceCandidate } from "../../db/queries/recurrences.js";
import { formatAmount } from "../../currency.js";
import type { RecordUnknownInput } from "../../db/queries/unknowns.js";
import type { Inspector, InspectorScope } from "./types.js";

/**
 * Surface recurrence candidates whose latest sighting landed in this scan run.
 * One unknown per candidate, attached to the most recent transaction in the
 * group. Skips candidates whose median interval is "irregular" — those are
 * unlikely to be real subscriptions and surfacing them just creates noise.
 */
function inspect(db: Database.Database, scope: InspectorScope): RecordUnknownInput[] {
  if (scope.fileIds.length === 0) return [];
  const candidates = findRecurrenceCandidates(db);
  if (candidates.length === 0) return [];

  const inScope = transactionsInScope(db, scope.fileIds);
  const out: RecordUnknownInput[] = [];

  for (const candidate of candidates) {
    if (candidate.implied_frequency === "irregular") continue;
    const latest = candidate.transactions[candidate.transactions.length - 1];
    if (!inScope.has(latest.id)) continue;

    out.push({
      file_id: null,
      transaction_id: latest.id,
      account_id: candidate.account_id,
      kind: "recurrence_candidate",
      prompt: buildPrompt(candidate, latest),
      options: ["Link as recurring", "Not recurring", "Skip"],
    });
  }
  return out;
}

function buildPrompt(candidate: RecurrenceCandidate, latest: { id: string; date: string; description: string }): string {
  const amount = formatAmount(candidate.amount, candidate.currency);
  const occurrences = candidate.transactions.length;
  return [
    `Possible ${candidate.implied_frequency} recurrence on ${candidate.account_name}: ${amount} (${occurrences} sightings, median ${candidate.median_days_between} days apart).`,
    `Latest: ${latest.date} — ${latest.description}`,
  ].join("\n");
}

function transactionsInScope(db: Database.Database, fileIds: readonly string[]): Set<string> {
  const placeholders = fileIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id FROM transactions WHERE source_file_id IN (${placeholders})`)
    .all(...fileIds) as { id: string }[];
  return new Set(rows.map(r => r.id));
}

export const recurrencesInspector: Inspector = { name: "recurrences", inspect };
