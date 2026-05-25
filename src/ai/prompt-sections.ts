import type Database from "libsql";
import { getMemories, type Memory } from "./memory.js";
import { countQuestions } from "../db/queries/questions.js";
import {
  getAccountBalances,
  type AccountBalance,
} from "../db/queries/account-balance.js";
import { stripControls } from "./sanitize.js";

/**
 * Small, single-purpose renderers that produce one Markdown-ish section each.
 * Builders compose them; each helper either returns a string or null (omit).
 *
 * Style:
 *  - No accumulation (`let prompt = …; prompt += …`).
 *  - No per-call branching the caller can't see — section options stay tiny.
 *  - String building stays in the helper; the builder only chooses *which*
 *    helpers to call and *in what order*.
 */

/** Date headers */

/** Long-form date for chat ("Today is Friday, March 5, 2026."). */
export function renderTodayHuman(): string {
  return `Today is ${new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  })}.`;
}

/** ISO date for scan/clarify ("Today is 2026-03-05."). */
export function renderTodayIso(): string {
  return `Today is ${new Date().toISOString().slice(0, 10)}.`;
}

/** Chart of accounts */

export interface ChartOfAccountsOptions {
  withBalance: boolean;
  /** Empty-state copy. `scan` hints at creating accounts; `clarify` is terse. */
  emptyState: "scan" | "clarify";
}

export function renderChartOfAccounts(
  db: Database.Database,
  opts: ChartOfAccountsOptions,
): string {
  const balances = getAccountBalances(db);
  if (balances.length === 0) {
    const empty =
      opts.emptyState === "scan"
        ? "(empty — you may need to create accounts; remember to pass parent_id under one of asset/liability/income/expense/equity)"
        : "(empty)";
    return `## Current chart of accounts\n${empty}`;
  }
  const rows = renderHierarchical(balances, opts.withBalance);
  return `## Current chart of accounts\n${rows.join("\n")}`;
}

/**
 * Chat's chart section has a different empty-state shape — it replaces the
 * whole "## Current chart of accounts" header with a user-facing call to
 * action that mentions the user by name. Worth its own helper instead of
 * branching the generic one.
 */
export function renderChatChartOrEmpty(
  db: Database.Database,
  name: string,
): string {
  const balances = getAccountBalances(db);
  if (balances.length === 0) {
    return `No accounts have been scanned yet. ${name} should drop files into ~/.plasalid/data/ and run \`plasalid scan\`.`;
  }
  const rows = renderHierarchical(balances, true);
  return `## Accounts on file\n${rows.join("\n")}`;
}

function renderHierarchical(
  balances: AccountBalance[],
  withBalance: boolean,
): string[] {
  const byId = new Map(balances.map((b) => [b.id, b]));
  const depthCache = new Map<string, number>();
  const depth = (id: string): number => {
    if (depthCache.has(id)) return depthCache.get(id)!;
    const node = byId.get(id);
    if (!node || !node.parent_id) {
      depthCache.set(id, 0);
      return 0;
    }
    const d = depth(node.parent_id) + 1;
    depthCache.set(id, d);
    return d;
  };
  return balances.map((a) => formatAccountRow(a, withBalance, depth(a.id)));
}

/** Memories */

export interface MemoriesOptions {
  header: string;
  /** When set, only memories whose category is in this list render. */
  filterCategories?: string[];
  /** When true, prepend `[category]` to each line. */
  showCategory: boolean;
}

export function renderMemories(
  db: Database.Database,
  opts: MemoriesOptions,
): string | null {
  const all = getMemories(db);
  const filtered = opts.filterCategories
    ? all.filter((m) => opts.filterCategories!.includes(m.category))
    : all;
  if (filtered.length === 0) return null;
  const lines = filtered.map((m) => formatMemoryLine(m, opts.showCategory));
  return `## ${opts.header}\n${lines.join("\n")}`;
}

/** Clarify scope */

export interface ScopeOptions {
  accountId?: string;
  from?: string;
  to?: string;
}

export function renderScope(opts: ScopeOptions): string {
  return [
    "## Scope",
    `- account: ${opts.accountId ?? "all"}`,
    `- from: ${opts.from ?? "all time"}`,
    `- to: ${opts.to ?? "now"}`,
  ].join("\n");
}

/** Chat user context */

export function renderUserContext(
  name: string,
  contextMd: string | null,
): string {
  const body =
    contextMd ??
    `(No personal context on file yet. ${name} can edit ~/.plasalid/context.md to add family, income, or other facts.)`;
  return `## About ${name}\n${body}`;
}

/** Internal formatters */

function formatAccountRow(
  a: AccountBalance,
  withBalance: boolean,
  depth = 0,
): string {
  const indent = "  ".repeat(depth);
  const subtype = a.subtype ? `/${a.subtype}` : "";
  const base = `- ${indent}${a.id} | ${a.name} | ${a.type}${subtype}`;
  return withBalance
    ? `${base} | balance ${a.balance.toFixed(2)} ${a.currency}`
    : base;
}

function formatMemoryLine(m: Memory, showCategory: boolean): string {
  return showCategory
    ? `- [${m.category}] ${stripControls(m.content)}`
    : `- ${stripControls(m.content)}`;
}

/** Open clarify-questions backlog (chat surface) */

/**
 * Emit a discreet hint about open clarify questions when the backlog is
 * non-empty. The chat agent decides when to mention it based on the user's
 * message — don't volunteer the count out of context. Returns null when the
 * backlog is empty so `joinSections` drops the slot entirely.
 */
export function renderOpenQuestionsHint(db: Database.Database): string | null {
  const n = countQuestions(db);
  if (n === 0) return null;
  return [
    "## Open clarify questions",
    `There ${n === 1 ? "is 1 open question" : `are ${n} open questions`} in the backlog. Mention this only when the user's message is related (e.g. they ask about uncategorized spending, a specific merchant, or "what's pending"); don't volunteer it otherwise. When you do mention it, suggest \`plasalid clarify\`.`,
  ].join("\n");
}
