import type Database from "libsql";
import type { ToolDefinition } from "../provider.js";
import type { ScanProgress } from "../../scanner/progress.js";
import type { ClosedQuestion } from "../../db/queries/questions.js";

export type ToolProfile = "scan" | "chat" | "record" | "resolve";

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
  /** Scan-only: tag questions inserted during this scan run. */
  scanId?: string;
  /** Scan-only: per-chunk progress sink for dashboard ticks. */
  progress?: ScanProgress;
  /** Scan-only: the chunk this agent invocation is processing. */
  chunkId?: string;
  /** Resolve-only: notified for each closed question so the caller can synthesize memory rules. */
  onQuestionClosed?: (closed: ClosedQuestion) => void;
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
