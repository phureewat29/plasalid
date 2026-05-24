import type Database from "libsql";
import type { ClosedQuestion } from "../db/queries/questions.js";
import { upsertRule } from "../db/queries/rules.js";

/**
 * Compact every closed question worth learning from into a `rules` row. The
 * deterministic clarifier pass looks rules up by `(kind, key)` via the
 * UNIQUE index, so each evidence event UPSERTs — incrementing
 * `evidence_count` and refreshing `last_seen_at` on repeats rather than
 * appending a near-duplicate.
 *
 * A closure is NOT learned (no rule synthesized) when any of:
 *   1. `kind` is in `RULE_KIND_DENYLIST` — failure-class kinds carry no
 *      generalizable signal.
 *   2. `answer` starts with `Skip` — skips are one-time recovery decisions,
 *      not patterns the next scan should auto-apply.
 *   3. `rule_key` is null — without a structural key the rule could only
 *      match its own prose, which embeds dates/amounts and never re-fires.
 *
 * Returns the count of rules upserted (new or repeat-evidence).
 */
export function synthesizeMemoryRules(
  db: Database.Database,
  closures: readonly ClosedQuestion[],
): number {
  let upserted = 0;
  for (const closure of closures) {
    if (!isRuleSource(closure)) continue;
    upsertRule(db, { kind: closure.kind!, key: closure.rule_key!, target: closure.answer.trim() });
    upserted++;
  }
  return upserted;
}

const RULE_KIND_DENYLIST: ReadonlySet<string> = new Set([
  "dirty_input",
  "scan_truncated",
  "boundary_continuation",
]);

function isRuleSource(c: ClosedQuestion): boolean {
  if (!c.kind || !c.rule_key) return false;
  if (RULE_KIND_DENYLIST.has(c.kind)) return false;
  if (isSkipAnswer(c.answer)) return false;
  return true;
}

function isSkipAnswer(answer: string): boolean {
  return answer.trim().toLowerCase().startsWith("skip");
}
