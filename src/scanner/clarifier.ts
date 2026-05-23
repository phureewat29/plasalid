import type Database from "libsql";
import {
  closeQuestion,
  listQuestions,
  countQuestions,
  type QuestionRow,
  type ClosedQuestion,
} from "../db/queries/questions.js";
import { updatePosting } from "../db/queries/transactions.js";
import { runResolveAgent } from "../ai/agent.js";
import { synthesizeMemoryRules } from "./resolver-memory.js";
import { converge } from "./converge.js";

export interface ResolverContext {
  readonly db: Database.Database;
  readonly tally: Record<string, number>;
}

export interface ResolverPass {
  readonly name: string;
  readonly kinds: readonly string[];
  /** Try to close one question. Returns the answer if closed, else null. */
  tryResolve(u: QuestionRow, ctx: ResolverContext): Promise<string | null>;
}

export interface ResolveSummary {
  readonly total: number;
  readonly resolved: number;
  readonly remaining: number;
  readonly tally: Readonly<Record<string, number>>;
}

export interface RunResolveOpts {
  db: Database.Database;
  /** Narrows to a single scan's questions. Omit = every question. */
  scanId?: string;
  interactive?: boolean;
  promptUser?: (prompt: string, options?: string[], facts?: any) => Promise<string>;
  onProgress?: (event: { phase: "tool" | "responding"; toolName?: string; toolCount: number; elapsedMs: number }) => void;
}

const MAX_AGENT_PASSES = 3;

/**
 * Apply deterministic passes via memory_rules lookups. Closes any question
 * whose prompt has a stored scanning_hint that already encodes the answer.
 */
const memoryRulePass: ResolverPass = {
  name: "memory_rule",
  kinds: ["uncategorized", "uncategorized_expense", "duplicate", "correlation", "recurrence_candidate", "similar_accounts", "boundary_continuation", "scan_truncated", "scan_commit_failure"],
  async tryResolve(u, ctx) {
    const rules = ctx.db
      .prepare(`SELECT content FROM memories WHERE category = 'scanning_hint'`)
      .all() as { content: string }[];
    const key = canonicalKey(u);
    for (const r of rules) {
      const match = parseRule(r.content);
      if (!match) continue;
      if (match.key === key) return match.answer;
    }
    return null;
  },
};

/**
 * For an uncategorized expense whose transaction has a merchant with a
 * stored default_account_id, apply the default to every expense posting on
 * that transaction.
 */
const merchantDefaultPass: ResolverPass = {
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

export const RESOLVER_PASSES: readonly ResolverPass[] = [
  memoryRulePass,
  merchantDefaultPass,
];

/**
 * Single entry point shared by the in-scan resolve phase and the standalone
 * `plasalid resolve` command. Runs deterministic passes first, then (when
 * interactive) hands the leftovers to the LLM resolver agent. Closed
 * questions get compacted into scanning_hint memories.
 */
export async function runResolve(opts: RunResolveOpts): Promise<ResolveSummary> {
  const { db } = opts;
  const tally: Record<string, number> = {};
  const closures: ClosedQuestion[] = [];

  const initial = listQuestions(db, { scanId: opts.scanId, limit: 1000 });
  const total = initial.length;
  if (total === 0) {
    return { total: 0, resolved: 0, remaining: 0, tally };
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
  return { total, resolved: total - remaining, remaining, tally };
}

function matchingPasses(u: QuestionRow): readonly ResolverPass[] {
  if (!u.kind) return [];
  return RESOLVER_PASSES.filter(p => p.kinds.includes(u.kind!));
}

async function tryPasses(
  u: QuestionRow,
  passes: readonly ResolverPass[],
  ctx: ResolverContext,
): Promise<{ passName: string; answer: string } | null> {
  for (const pass of passes) {
    let answer: string | null;
    try {
      answer = await pass.tryResolve(u, ctx);
    } catch (err) {
      console.error(`[resolver pass ${pass.name}] ${err instanceof Error ? err.message : String(err)}`);
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
 * Stall-protected outer loop around the LLM resolver. Each pass re-fetches
 * leftover questions, hands them to the agent, and the agent closes what it
 * can via close_question / ask_user. The loop stops when nothing closes
 * between passes. After each pass we diff the pre/post set to recover the
 * (prompt, kind, answer) tuples the agent closed without going through the
 * memoryRulePass path.
 */
async function runAgentLoop(
  opts: RunResolveOpts,
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
      await runResolveAgent({
        db,
        prompt: {},
        initialMessages: [{ role: "user", content: buildResolveUserMessage(before) }],
        agentCtx: {
          interactive: true,
          promptUser: opts.promptUser,
          onQuestionClosed: (closed) => {
            closures.push(closed);
            tally["agent_resolution"] = (tally["agent_resolution"] ?? 0) + 1;
          },
        },
        onProgress: opts.onProgress,
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

function canonicalKey(u: QuestionRow): string {
  return `[${u.kind ?? "general"}] ${u.prompt.replace(/\s+/g, " ").trim()}`;
}

function parseRule(body: string): { key: string; answer: string } | null {
  const idx = body.lastIndexOf(" -> ");
  if (idx < 0) return null;
  const key = body.slice(0, idx).trim();
  const answer = body.slice(idx + 4).trim();
  if (!key || !answer) return null;
  return { key, answer };
}
