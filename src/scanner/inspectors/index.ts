import type Database from "libsql";
import { recordUnknown } from "../../db/queries/unknowns.js";
import { duplicatesInspector } from "./duplicates.js";
import { correlationsInspector } from "./correlations.js";
import { recurrencesInspector } from "./recurrences.js";
import { similarAccountsInspector } from "./similarities.js";
import type { Inspector, InspectorScope } from "./types.js";

export type { Inspector, InspectorScope } from "./types.js";

/**
 * The ordered list of post-commit inspectors the scanner runs. Order matters
 * only for the resolver's priority sweep, not for correctness — each inspector
 * emits unknowns independently of the others.
 */
export const inspectors: readonly Inspector[] = [
  duplicatesInspector,
  correlationsInspector,
  recurrencesInspector,
  similarAccountsInspector,
];

export interface InspectionRunResult {
  total: number;
  byInspector: Record<string, number>;
}

/**
 * Run every inspector in order and insert any unknowns they produce. Returns
 * counts so the CLI can report "X unknowns surfaced." Failure of one inspector
 * never aborts the run — it logs and the others still execute.
 */
export function runInspectors(
  db: Database.Database,
  scope: InspectorScope,
): InspectionRunResult {
  const byInspector: Record<string, number> = {};
  let total = 0;
  for (const inspector of inspectors) {
    try {
      const unknowns = inspector.inspect(db, scope);
      for (const u of unknowns) recordUnknown(db, u);
      byInspector[inspector.name] = unknowns.length;
      total += unknowns.length;
    } catch (err: any) {
      byInspector[inspector.name] = 0;
      console.error(`[inspector ${inspector.name}] ${err?.message ?? err}`);
    }
  }
  return { total, byInspector };
}
