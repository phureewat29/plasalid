import type Database from "libsql";
import type { ToolDefinition } from "../provider.js";
import type { SharedBuffer } from "../../scanner/buffer/sharedBuffer.js";

export type ToolProfile = "scan" | "chat" | "record";

/**
 * Structured highlights an interactive agent can pass to ask_user. The prompter
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
  /** Set during scan so writes can be stamped with `source_file_id`. */
  fileId?: string;
  /** When false, ask_user returns a marker and the caller halts after the run. */
  interactive: boolean;
  /** Synchronously prompt the user (only invoked when interactive === true). */
  promptUser?: (prompt: string, options?: string[], facts?: PromptUserFacts) => Promise<string>;
  /** Called when the model declares the session is done (scan or record). */
  onComplete?: (summary: string) => void;
  /**
   * Which top-level command this agent serves. Mutating tools branch on this
   * to decide whether to append an action_log row (currently only "record").
   */
  command?: "scan" | "record";
  /** Per-invocation id grouping every action_log row from one CLI run. */
  correlationId?: string;
  /** The raw user utterance / file path that started this invocation. */
  userInput?: string;
  /**
   * Scan-only: the shared buffer every chunk worker writes to. Transactions
   * and unknowns queue here and the auditor consumes them in flight.
   */
  buffer?: SharedBuffer;
  /** Scan-only: the chunk this agent invocation is processing. */
  chunkId?: string;
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
