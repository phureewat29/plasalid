import type Database from "libsql";
import {
  listQuestions,
  countQuestions,
  type QuestionRow,
  type ClosedQuestion,
} from "../db/queries/questions.js";
import {
  deleteTransaction,
  findDuplicateTransactions,
  type DuplicateGroupTransaction,
} from "../db/queries/transactions.js";
import { runClarifyAgent } from "../ai/agent.js";
import { refreshHints } from "../ai/hints.js";

export interface ClarifySummary {
  readonly total: number;
  readonly clarified: number;
  readonly remaining: number;
  readonly tally: Readonly<Record<string, number>>;
}

export interface RunClarifyOpts {
  db: Database.Database;
  // Omit to clarify every question, not just one scan's.
  scanId?: string;
  interactive?: boolean;
  promptUser?: (
    prompt: string,
    options?: string[],
    facts?: any,
  ) => Promise<string>;
  onProgress?: (event: {
    phase: "tool" | "responding";
    toolName?: string;
    toolCount: number;
    elapsedMs: number;
  }) => void;
  signal?: AbortSignal;
}

const MAX_CLARIFY_ATTEMPTS = 2;

export async function runClarify(
  opts: RunClarifyOpts,
): Promise<ClarifySummary> {
  const { db } = opts;
  const tally: Record<string, number> = {};

  const autoMerged = autoMergeStrictDuplicates(db);
  if (autoMerged > 0) tally["dedup_auto_merge"] = autoMerged;

  const interactive = opts.interactive ?? true;
  const total = listQuestions(db, { scanId: opts.scanId, limit: 1000 }).length;
  if (total > 0 && interactive) {
    await runAgentLoop(opts, tally);
  }

  if (interactive) {
    await tryRefreshHints(db);
  }

  const remaining = countRemaining(db, opts.scanId);
  return { total, clarified: total - remaining, remaining, tally };
}

async function tryRefreshHints(db: Database.Database): Promise<void> {
  try {
    await refreshHints(db);
  } catch (err) {
    console.error(`[hints] ${err instanceof Error ? err.message : String(err)}`);
  }
}

function autoMergeStrictDuplicates(db: Database.Database): number {
  let removed = 0;
  for (const group of findDuplicateTransactions(db)) {
    removed += autoMergeStrictGroup(db, group);
  }
  return removed;
}

function autoMergeStrictGroup(
  db: Database.Database,
  group: DuplicateGroupTransaction[],
): number {
  const sorted = [...group].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  const head = sorted[0];
  if (!head.merchant_id || !head.source_file_id) return 0;

  let deleted = 0;
  for (let i = 1; i < sorted.length; i++) {
    const cand = sorted[i];
    if (
      cand.merchant_id === head.merchant_id &&
      cand.source_file_id === head.source_file_id &&
      cand.date === head.date &&
      Math.round(cand.amount * 100) === Math.round(head.amount * 100)
    ) {
      deleteTransaction(db, cand.id);
      deleted++;
    }
  }
  return deleted;
}

function countRemaining(db: Database.Database, scanId?: string): number {
  return scanId ? countQuestions(db, { scan_id: scanId }) : countQuestions(db);
}

async function runAgentLoop(
  opts: RunClarifyOpts,
  tally: Record<string, number>,
): Promise<void> {
  const { db } = opts;
  let prev = countRemaining(db, opts.scanId);
  for (let pass = 0; pass < MAX_CLARIFY_ATTEMPTS; pass++) {
    if (prev === 0) return;
    const open = listQuestions(db, { scanId: opts.scanId, limit: 1000 });
    if (open.length === 0) return;

    await runClarifyAgent({
      db,
      prompt: {},
      initialMessages: [
        { role: "user", content: buildResolveUserMessage(open) },
      ],
      agentCtx: {
        interactive: true,
        promptUser: opts.promptUser,
        onQuestionClosed: (_closed: ClosedQuestion) => {
          tally["agent_clarification"] =
            (tally["agent_clarification"] ?? 0) + 1;
        },
      },
      onProgress: opts.onProgress,
      signal: opts.signal,
    });

    const curr = countRemaining(db, opts.scanId);
    if (curr === 0) return;
    if (curr >= prev) return; // stalled
    prev = curr;
  }
}

function buildResolveUserMessage(questions: readonly QuestionRow[]): string {
  const lines = [
    `${questions.length} question(s) to resolve.`,
    ``,
    `Questions:`,
  ];
  for (const c of questions) {
    const options = parseOptions(c.options_json);
    const optionsStr =
      options.length > 0 ? ` | options=[${options.join(" / ")}]` : "";
    lines.push(
      `- ${c.id} | kind=${c.kind ?? "(none)"} | tx=${c.transaction_id ?? "(none)"} | acct=${c.account_id ?? "(none)"} | file=${c.file_id ?? "(none)"}${optionsStr}`,
      `    prompt: ${c.prompt.replace(/\n/g, " ")}`,
    );
  }
  return lines.join("\n");
}

function parseOptions(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((o): o is string => typeof o === "string")
      : [];
  } catch {
    return [];
  }
}
