import type Database from "libsql";
import type { ToolDefinition } from "../provider.js";
import type { AgentExecutionContext, ToolModule, ToolProfile } from "./types.js";
import { commonTools } from "./common.js";
import { readTools } from "./read.js";
import { accountIngestTools, scanConcernTools, reviewIngestTools } from "./ingest.js";
import { scanTools } from "./scan.js";
import { reviewTools } from "./review.js";
import { recordTools } from "./record.js";
import { merchantTools } from "./merchants.js";

export type { AgentExecutionContext, ToolProfile } from "./types.js";

/**
 * Profile composition. Each profile is the union of one or more tool modules;
 * the dispatcher iterates every module on each tool call so we never need a
 * central switch.
 *
 * `accountIngestTools` (create_account / update_account_metadata /
 * record_transaction) ships with scan, review, and record — they're the
 * shared write primitives. `scanConcernTools` (note_concern) is scan-only;
 * record uses `clarify` from `recordTools` for transient prompts, review uses
 * `ask_user` from `reviewIngestTools` for resolve-in-place clarifications.
 * `merchantTools` ships with scan, review, and record so any write profile can
 * upsert / look up / re-cache merchants alongside the posting flow.
 */
const PROFILES: Record<ToolProfile, ToolModule[]> = {
  scan:   [commonTools, accountIngestTools, scanConcernTools, scanTools, merchantTools],
  chat:   [commonTools, readTools],
  review: [commonTools, readTools, accountIngestTools, reviewIngestTools, reviewTools, merchantTools],
  record: [commonTools, readTools, accountIngestTools, recordTools, merchantTools],
};

export function getToolDefinitions(profile: ToolProfile): ToolDefinition[] {
  return PROFILES[profile].flatMap(m => m.DEFS);
}

export async function executeTool(
  db: Database.Database,
  name: string,
  input: any,
  ctx?: AgentExecutionContext,
): Promise<string> {
  for (const mod of [
    commonTools,
    readTools,
    accountIngestTools,
    scanConcernTools,
    reviewIngestTools,
    scanTools,
    reviewTools,
    recordTools,
    merchantTools,
  ]) {
    const result = await mod.execute(db, name, input, ctx);
    if (result !== undefined) return result;
  }
  return `Unknown tool: ${name}`;
}

/** Human-readable labels shown in the spinner during tool calls. */
export const TOOL_LABELS: Record<string, string> = {
  ...commonTools.LABELS,
  ...readTools.LABELS,
  ...accountIngestTools.LABELS,
  ...scanConcernTools.LABELS,
  ...reviewIngestTools.LABELS,
  ...scanTools.LABELS,
  ...reviewTools.LABELS,
  ...recordTools.LABELS,
  ...merchantTools.LABELS,
};
