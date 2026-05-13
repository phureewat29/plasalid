import type Database from "libsql";
import type { ToolDefinition } from "../provider.js";
import type { AgentExecutionContext, ToolModule, ToolProfile } from "./types.js";
import { commonTools } from "./common.js";
import { readTools } from "./read.js";
import { ingestTools } from "./ingest.js";
import { scanTools } from "./scan.js";
import { reconcileTools } from "./reconcile.js";

export type { AgentExecutionContext, ToolProfile } from "./types.js";

/**
 * Profile composition. Each profile is the union of one or more tool modules;
 * the dispatcher iterates every module on each tool call so we never need a
 * central switch.
 */
const PROFILES: Record<ToolProfile, ToolModule[]> = {
  scan: [commonTools, ingestTools, scanTools],
  chat: [commonTools, readTools],
  reconcile: [commonTools, readTools, ingestTools, reconcileTools],
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
  for (const mod of [commonTools, readTools, ingestTools, scanTools, reconcileTools]) {
    const result = await mod.execute(db, name, input, ctx);
    if (result !== undefined) return result;
  }
  return `Unknown tool: ${name}`;
}

/** Human-readable labels shown in the spinner during tool calls. */
export const TOOL_LABELS: Record<string, string> = {
  ...commonTools.LABELS,
  ...readTools.LABELS,
  ...ingestTools.LABELS,
  ...scanTools.LABELS,
  ...reconcileTools.LABELS,
};
