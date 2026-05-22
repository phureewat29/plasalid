import type Database from "libsql";
import type { ToolDefinition } from "../provider.js";
import type { AgentExecutionContext, ToolModule, ToolProfile } from "./types.js";
import { commonTools } from "./common.js";
import { readTools } from "./read.js";
import { accountIngestTools, scanUnknownTools } from "./ingest.js";
import { scanTools } from "./scan.js";
import { recordTools } from "./record.js";
import { merchantTools } from "./merchants.js";

export type { AgentExecutionContext, ToolProfile } from "./types.js";

/**
 * Profile composition. Each profile is the union of one or more tool modules;
 * the dispatcher iterates every module on each tool call so we never need a
 * central switch.
 *
 * `accountIngestTools` (create_account / update_account_metadata /
 * record_transaction) ships with scan, resolve, and record — they're the
 * shared write primitives. `scanUnknownTools` (note_unknown) is scan-only;
 * record uses `clarify` from `recordTools` for transient prompts, resolve uses
 * `ask_user` from `resolveIngestTools` for resolve-in-place clarifications.
 * `merchantTools` ships with scan, resolve, and record so any write profile can
 * upsert / look up / re-cache merchants alongside the posting flow.
 */
const PROFILES: Record<ToolProfile, ToolModule[]> = {
  scan:    [commonTools, accountIngestTools, scanUnknownTools, scanTools, merchantTools],
  chat:    [commonTools, readTools],
  record:  [commonTools, readTools, accountIngestTools, recordTools, merchantTools],
};

export function getToolDefinitions(profile: ToolProfile): ToolDefinition[] {
  return PROFILES[profile].flatMap(m => m.DEFS);
}

export interface ExecuteToolResult {
  content: string;
  isError: boolean;
}

const MODULES = [
  commonTools,
  readTools,
  accountIngestTools,
  scanUnknownTools,
  scanTools,
  recordTools,
  merchantTools,
];

export async function executeTool(
  db: Database.Database,
  name: string,
  input: any,
  ctx?: AgentExecutionContext,
): Promise<ExecuteToolResult> {
  try {
    for (const mod of MODULES) {
      const result = await mod.execute(db, name, input, ctx);
      if (result !== undefined) return { content: result, isError: false };
    }
    return { content: `Unknown tool: ${name}`, isError: true };
  } catch (err: any) {
    return { content: err?.message ?? String(err), isError: true };
  }
}

/** Human-readable labels shown in the spinner during tool calls. */
export const TOOL_LABELS: Record<string, string> = {
  ...commonTools.LABELS,
  ...readTools.LABELS,
  ...accountIngestTools.LABELS,
  ...scanUnknownTools.LABELS,
  ...scanTools.LABELS,
  ...recordTools.LABELS,
  ...merchantTools.LABELS,
};
