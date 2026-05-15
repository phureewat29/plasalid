import type Database from "libsql";
import { getMemories, type Memory } from "./memory.js";
import { getAccountBalances, type AccountBalance } from "../db/queries/account_balance.js";
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

// ── Date headers ────────────────────────────────────────────────────────────

/** Long-form date for chat ("Today is Friday, March 5, 2026."). */
export function renderTodayHuman(): string {
  return `Today is ${new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  })}.`;
}

/** ISO date for scan/review ("Today is 2026-03-05."). */
export function renderTodayIso(): string {
  return `Today is ${new Date().toISOString().slice(0, 10)}.`;
}

// ── Chart of accounts ──────────────────────────────────────────────────────

export interface ChartOfAccountsOptions {
  withBalance: boolean;
  /** Empty-state copy. `scan` hints at creating accounts; `review` is terse. */
  emptyState: "scan" | "review";
}

export function renderChartOfAccounts(
  db: Database.Database,
  opts: ChartOfAccountsOptions,
): string {
  const balances = getAccountBalances(db);
  if (balances.length === 0) {
    const empty = opts.emptyState === "scan"
      ? "(empty — you may need to create accounts)"
      : "(empty)";
    return `## Current chart of accounts\n${empty}`;
  }
  const rows = balances.map(a => formatAccountRow(a, opts.withBalance));
  return `## Current chart of accounts\n${rows.join("\n")}`;
}

/**
 * Chat's chart section has a different empty-state shape — it replaces the
 * whole "## Current chart of accounts" header with a user-facing call to
 * action that mentions the user by name. Worth its own helper instead of
 * branching the generic one.
 */
export function renderChatChartOrEmpty(db: Database.Database, name: string): string {
  const balances = getAccountBalances(db);
  if (balances.length === 0) {
    return `No accounts have been scanned yet. ${name} should drop files into ~/.plasalid/data/ and run \`plasalid scan\`.`;
  }
  const rows = balances.map(a => formatAccountRow(a, true));
  return `## Accounts on file\n${rows.join("\n")}`;
}

// ── Memories ────────────────────────────────────────────────────────────────

export interface MemoriesOptions {
  header: string;
  /** When set, only memories whose category is in this list render. */
  filterCategories?: string[];
  /** When true, prepend `[category]` to each line. */
  showCategory: boolean;
}

export function renderMemories(db: Database.Database, opts: MemoriesOptions): string | null {
  const all = getMemories(db);
  const filtered = opts.filterCategories
    ? all.filter(m => opts.filterCategories!.includes(m.category))
    : all;
  if (filtered.length === 0) return null;
  const lines = filtered.map(m => formatMemoryLine(m, opts.showCategory));
  return `## ${opts.header}\n${lines.join("\n")}`;
}

// ── Review scope ────────────────────────────────────────────────────────────

export interface ScopeOptions {
  accountId?: string;
  from?: string;
  to?: string;
  dryRun: boolean;
}

export function renderScope(opts: ScopeOptions): string {
  return [
    "## Scope",
    `- account: ${opts.accountId ?? "all"}`,
    `- from: ${opts.from ?? "all time"}`,
    `- to: ${opts.to ?? "now"}`,
    `- dry run: ${opts.dryRun
      ? "yes — write tools will not mutate the DB"
      : "no — write tools will mutate the DB after confirmation"}`,
  ].join("\n");
}

// ── Chat user context ──────────────────────────────────────────────────────

export function renderUserContext(name: string, contextMd: string | null): string {
  const body = contextMd ?? `(No personal context on file yet. ${name} can edit ~/.plasalid/context.md to add family, income, or other facts.)`;
  return `## About ${name}\n${body}`;
}

// ── Internal formatters ────────────────────────────────────────────────────

function formatAccountRow(a: AccountBalance, withBalance: boolean): string {
  const subtype = a.subtype ? `/${a.subtype}` : "";
  const base = `- ${a.id} | ${a.name} | ${a.type}${subtype}`;
  return withBalance ? `${base} | balance ${a.balance.toFixed(2)} ${a.currency}` : base;
}

function formatMemoryLine(m: Memory, showCategory: boolean): string {
  return showCategory
    ? `- [${m.category}] ${stripControls(m.content)}`
    : `- ${stripControls(m.content)}`;
}
