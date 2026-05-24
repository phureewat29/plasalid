import type Database from "libsql";
import type { ToolDefinition } from "../provider.js";
import type { AgentExecutionContext, ToolModule, ToolProfile } from "./types.js";
import { commonTools } from "./common.js";
import { readTools } from "./read.js";
import { accountIngestTools, scanQuestionTools, clarifyIngestTools } from "./ingest.js";
import { scanTools } from "./scan.js";
import { clarifyTools } from "./clarify.js";
import { recordTools } from "./record.js";
import { merchantTools } from "./merchants.js";
import { mutateTools } from "./mutate.js";

export type { AgentExecutionContext, ToolProfile } from "./types.js";

/**
 * Profile composition. Each profile is the union of one or more tool modules;
 * the dispatcher iterates every module on each tool call so we never need a
 * central switch.
 */
const PROFILES: Record<ToolProfile, ToolModule[]> = {
  scan:    [commonTools, accountIngestTools, scanQuestionTools, scanTools, merchantTools],
  chat:    [commonTools, readTools, accountIngestTools, clarifyTools, merchantTools, mutateTools],
  clarify: [commonTools, readTools, accountIngestTools, clarifyIngestTools, clarifyTools, merchantTools, mutateTools],
  record:  [commonTools, readTools, accountIngestTools, recordTools, clarifyTools, merchantTools, mutateTools],
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
  clarifyIngestTools,
  scanTools,
  clarifyTools,
  recordTools,
  merchantTools,
  mutateTools,
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
  ...clarifyIngestTools.LABELS,
  ...scanTools.LABELS,
  ...clarifyTools.LABELS,
  ...recordTools.LABELS,
  ...merchantTools.LABELS,
  ...mutateTools.LABELS,
};
