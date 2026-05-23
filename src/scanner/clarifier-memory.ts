import type Database from "libsql";
import type { ClosedQuestion } from "../db/queries/questions.js";

/**
 * Compact every closed question into a memories row (category `scanning_hint`).
 * The next scan's deterministic memoryRulePass picks them up. Dedups on body —
 * an identical rule for the same kind + prompt won't be re-inserted.
 */
export function synthesizeMemoryRules(
  db: Database.Database,
  closures: readonly ClosedQuestion[],
): number {
  if (closures.length === 0) return 0;
  let inserted = 0;
  const exists = db.prepare(`SELECT 1 FROM memories WHERE category = ? AND content = ? LIMIT 1`);
  const insert = db.prepare(`INSERT INTO memories (content, category) VALUES (?, ?)`);
  for (const c of closures) {
    const body = formatRule(c);
    if (exists.get("scanning_hint", body)) continue;
    insert.run(body, "scanning_hint");
    inserted++;
  }
  return inserted;
}

function formatRule(c: ClosedQuestion): string {
  const kindLabel = c.kind ?? "general";
  return `[${kindLabel}] ${c.prompt.replace(/\s+/g, " ").trim()} -> ${c.answer.trim()}`;
}
