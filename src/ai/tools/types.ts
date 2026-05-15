import type Database from "libsql";
import type { ToolDefinition } from "../provider.js";
import type { BufferedWriteContext } from "../../scanner/buffer.js";

export type ToolProfile = "scan" | "chat" | "review";

/**
 * Structured highlights the review agent can pass to ask_user. The prompter
 * renders them as a single colored header line above the question (each
 * category gets its own chalk color), so the user can scan amount / date /
 * merchant / accounts at a glance without parsing prose.
 */
export interface PromptUserFacts {
  amount?: string;
  date?: string;
  merchant?: string;
  accounts?: string[];
}

export interface AgentExecutionContext {
  /** Set during scan so `record_journal_entry` can stamp `source_file_id`. */
  fileId?: string;
  /** When false, ask_user returns a marker and the caller halts after the run. */
  interactive: boolean;
  /** When true, mutating tools become no-ops that return a "would do X" preview. */
  dryRun?: boolean;
  /** Synchronously prompt the user (only invoked when interactive === true). */
  promptUser?: (prompt: string, options?: string[], facts?: PromptUserFacts) => Promise<string>;
  /** Called when the model declares the session is done (scan or review). */
  onComplete?: (summary: string) => void;
  /**
   * Scan-only: when set, journal entries and concerns are queued here instead
   * of being written directly to the DB. Account writes still hit the DB
   * eagerly (serialized via account_mutex) so concurrent scan agents share
   * the same chart of accounts.
   */
  buffer?: BufferedWriteContext;
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
