import type Database from "libsql";
import {
  closeQuestion,
  listQuestions,
  countQuestions,
  type QuestionRow,
  type ClosedQuestion,
} from "../db/queries/questions.js";
import { updatePosting } from "../db/queries/transactions.js";
import { findRule } from "../db/queries/rules.js";
import { runClarifyAgent } from "../ai/agent.js";
import { synthesizeMemoryRules } from "./clarifier-memory.js";
import {
  applyRecurrenceRules,
  generateRecurrenceCandidateQuestions,
} from "./recurrence.js";
import { converge } from "./converge.js";

export interface ClarifierContext {
  readonly db: Database.Database;
  readonly tally: Record<string, number>;
}

export interface ClarifierPass {
  readonly name: string;
  readonly kinds: readonly string[];
  /** Try to close one question. Returns the answer if closed, else null. */
  tryResolve(u: QuestionRow, ctx: ClarifierContext): Promise<string | null>;
}

export interface ClarifySummary {
  readonly total: number;
  readonly clarified: number;
  readonly remaining: number;
  readonly tally: Readonly<Record<string, number>>;
}

export interface RunClarifyOpts {
  db: Database.Database;
  /** Narrows to a single scan's questions. Omit = every question. */
  scanId?: string;
  interactive?: boolean;
  promptUser?: (prompt: string, options?: string[], facts?: any) => Promise<string>;
  onProgress?: (event: { phase: "tool" | "responding"; toolName?: string; toolCount: number; elapsedMs: number }) => void;
  /** When set and aborted, runClarify stops between passes/questions. */
  signal?: AbortSignal;
}

const MAX_AGENT_PASSES = 2;

/**
 * Apply deterministic resolution via a `(kind, key)` indexed lookup in the
 * rules table. The rule's `key` was computed at question-creation time
 * (see `src/scanner/committer.ts`) from a stable structural signature — merchant id,
 * normalized descriptor, account pair — so the same pattern matches
 * across scans regardless of date, amount, or prompt prose.
 */
const memoryRulePass: ClarifierPass = {
  name: "memory_rule",
  kinds: [
    "uncategorized",
    "uncategorized_expense",
    "duplicate",
    "correlation",
    "similar_accounts",
    "boundary_continuation",
    "scan_truncated",
    "unknown_merchant",
  ],
  async tryResolve(u, ctx) {
    if (!u.kind) return null;
    const key = extractRuleKey(u.context_json);
    if (!key) return null;
    const rule = findRule(ctx.db, u.kind, key);
    return rule?.target ?? null;
  },
};

/**
 * For an uncategorized expense whose transaction has a merchant with a
 * stored default_account_id, apply the default to every expense posting on
 * that transaction.
 */
const merchantDefaultPass: ClarifierPass = {
  name: "merchant_default",
  kinds: ["uncategorized_expense"],
  async tryResolve(u, ctx) {
    if (!u.transaction_id) return null;
    const tx = ctx.db
      .prepare(`SELECT merchant_id FROM transactions WHERE id = ?`)
      .get(u.transaction_id) as { merchant_id: string | null } | undefined;
    if (!tx?.merchant_id) return null;
    const merchant = ctx.db
      .prepare(`SELECT default_account_id FROM merchants WHERE id = ?`)
      .get(tx.merchant_id) as { default_account_id: string | null } | undefined;
    const target = merchant?.default_account_id;
    if (!target) return null;
    const postings = ctx.db
      .prepare(
        `SELECT p.id FROM postings p
         JOIN accounts a ON a.id = p.account_id
         WHERE p.transaction_id = ? AND a.id = 'expense:uncategorized'`,
      )
      .all(u.transaction_id) as { id: string }[];
    if (postings.length === 0) return null;
    for (const p of postings) {
      updatePosting(ctx.db, p.id, { account_id: target });
    }
    return target;
  },
};

export const CLARIFIER_PASSES: readonly ClarifierPass[] = [
  memoryRulePass,
  merchantDefaultPass,
];

/**
 * Single entry point shared by the in-scan resolve phase and the standalone
 * `plasalid clarify` command. Runs deterministic passes first, then (when
 * interactive) hands the leftovers to the LLM clarifier agent. Closed
 * questions get upserted into the rules table (keyed on the question's
 * structural signature, not its prose).
 */
export async function runClarify(opts: RunClarifyOpts): Promise<ClarifySummary> {
  const { db } = opts;
  const tally: Record<string, number> = {};
  const closures: ClosedQuestion[] = [];

  const autoLinked = applyRecurrenceRules(db).linked;
  if (autoLinked > 0) tally["recurrence_auto_link"] = autoLinked;
  const generated = generateRecurrenceCandidateQuestions(db, opts.scanId ?? null);
  if (generated > 0) tally["recurrence_generation"] = generated;

  const initial = listQuestions(db, { scanId: opts.scanId, limit: 1000 });
  const total = initial.length;
  if (total === 0) {
    return { total: 0, clarified: 0, remaining: 0, tally };
  }

  for (const u of initial) {
    const passes = matchingPasses(u);
    if (passes.length === 0) continue;
    const result = await tryPasses(u, passes, { db, tally });
    if (!result) continue;
    const closed = closeQuestion(db, u.id, result.answer);
    if (!closed) continue;
    closures.push(closed);
    tally[result.passName] = (tally[result.passName] ?? 0) + 1;
  }

  const interactive = opts.interactive ?? true;
  if (interactive && countRemaining(db, opts.scanId) > 0) {
    await runAgentLoop(opts, closures, tally);
  }

  synthesizeMemoryRules(db, closures);
  const remaining = countRemaining(db, opts.scanId);
  return { total, clarified: total - remaining, remaining, tally };
}

function matchingPasses(u: QuestionRow): readonly ClarifierPass[] {
  if (!u.kind) return [];
  return CLARIFIER_PASSES.filter(p => p.kinds.includes(u.kind!));
}

async function tryPasses(
  u: QuestionRow,
  passes: readonly ClarifierPass[],
  ctx: ClarifierContext,
): Promise<{ passName: string; answer: string } | null> {
  for (const pass of passes) {
    let answer: string | null;
    try {
      answer = await pass.tryResolve(u, ctx);
    } catch (err) {
      console.error(`[clarifier pass ${pass.name}] ${err instanceof Error ? err.message : String(err)}`);
      answer = null;
    }
    if (answer != null) return { passName: pass.name, answer };
  }
  return null;
}

function countRemaining(db: Database.Database, scanId?: string): number {
  return scanId ? countQuestions(db, { scan_id: scanId }) : countQuestions(db);
}

/**
 * Stall-protected outer loop around the LLM clarifier. Each pass re-fetches
 * leftover questions, hands them to the agent, and the agent closes what it
 * can via close_question / ask_user. The loop stops when nothing closes
 * between passes. After each pass we diff the pre/post set to recover the
 * (prompt, kind, answer) tuples the agent closed without going through the
 * memoryRulePass path.
 */
async function runAgentLoop(
  opts: RunClarifyOpts,
  closures: ClosedQuestion[],
  tally: Record<string, number>,
): Promise<void> {
  const { db } = opts;
  await converge<number>({
    initial: countRemaining(db, opts.scanId),
    maxAttempts: MAX_AGENT_PASSES,
    isDone: (n) => n === 0,
    isStalled: (curr, prev) => curr >= prev,
    onPass: async () => {
      const before = listQuestions(db, { scanId: opts.scanId, limit: 1000 });
      if (before.length === 0) return 0;
      await runClarifyAgent({
        db,
        prompt: {},
        initialMessages: [{ role: "user", content: buildResolveUserMessage(before) }],
        agentCtx: {
          interactive: true,
          promptUser: opts.promptUser,
          onQuestionClosed: (closed) => {
            closures.push(closed);
            tally["agent_clarification"] = (tally["agent_clarification"] ?? 0) + 1;
          },
        },
        onProgress: opts.onProgress,
        signal: opts.signal,
      });
      return countRemaining(db, opts.scanId);
    },
  });
}

function buildResolveUserMessage(questions: readonly QuestionRow[]): string {
  const lines = [`${questions.length} question(s) to resolve.`, ``, `Questions:`];
  for (const c of questions) {
    const options = parseOptions(c.options_json);
    const optionsStr = options.length > 0 ? ` | options=[${options.join(" / ")}]` : "";
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
    return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === "string") : [];
  } catch {
    return [];
  }
}

function extractRuleKey(contextJson: string | null): string | null {
  if (!contextJson) return null;
  try {
    const parsed = JSON.parse(contextJson);
    return typeof parsed?.rule_key === "string" ? parsed.rule_key : null;
  } catch {
    return null;
  }
}
