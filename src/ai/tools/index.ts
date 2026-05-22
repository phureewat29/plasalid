import type Database from "libsql";
import type { ToolDefinition } from "../provider.js";
import type { AgentExecutionContext, ToolModule, ToolProfile } from "./types.js";
import { commonTools } from "./common.js";
import { readTools } from "./read.js";
import { accountIngestTools, scanQuestionTools, resolveIngestTools } from "./ingest.js";
import { scanTools } from "./scan.js";
import { resolveTools } from "./resolve.js";
import { recordTools } from "./record.js";
import { merchantTools } from "./merchants.js";

export type { AgentExecutionContext, ToolProfile } from "./types.js";

/**
 * Profile composition. Each profile is the union of one or more tool modules;
 * the dispatcher iterates every module on each tool call so we never need a
 * central switch.
 */
const PROFILES: Record<ToolProfile, ToolModule[]> = {
  scan:    [commonTools, accountIngestTools, scanQuestionTools, scanTools, merchantTools],
  chat:    [commonTools, readTools],
  resolve: [commonTools, readTools, accountIngestTools, resolveIngestTools, resolveTools, merchantTools],
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
  scanQuestionTools,
  resolveIngestTools,
  scanTools,
  resolveTools,
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
  ...scanQuestionTools.LABELS,
  ...resolveIngestTools.LABELS,
  ...scanTools.LABELS,
  ...resolveTools.LABELS,
  ...recordTools.LABELS,
  ...merchantTools.LABELS,
};
