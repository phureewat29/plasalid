import type Database from "libsql";
import type { ToolDefinition } from "../provider.js";

export type ToolProfile = "scan" | "chat" | "reconcile";

export interface AgentExecutionContext {
  /** Set during scan so `record_journal_entry` can stamp `source_file_id`. */
  fileId?: string;
  /** When false, ask_user returns a marker and the caller halts after the run. */
  interactive: boolean;
  /** When true, mutating tools become no-ops that return a "would do X" preview. */
  dryRun?: boolean;
  /** Synchronously prompt the user (only invoked when interactive === true). */
  promptUser?: (prompt: string, options?: string[]) => Promise<string>;
  /** Called when the model declares the session is done (scan or reconcile). */
  onComplete?: (summary: string) => void;
}

/**
 * A tool module owns a slice of tool definitions, the spinner labels that go
 * with them, and an executor that returns `undefined` when the tool name isn't
 * one of its own. Composing modules at the dispatcher layer is just iteration.
 */
export interface ToolModule {
  readonly DEFS: ToolDefinition[];
  readonly LABELS: Record<string, string>;
  execute(
    db: Database.Database,
    name: string,
    input: any,
    ctx: AgentExecutionContext | undefined,
  ): Promise<string | undefined>;
}

export type { ToolDefinition };
