import type Database from "libsql";
import { config } from "../config.js";
import { readContext } from "./context.js";
import { chatPersona, SCAN_PERSONA, RESOLVE_PERSONA, RECORD_PERSONA } from "./personas.js";
import { getThaiTaxonomyHint } from "../accounts/taxonomy.js";
import {
  renderChartOfAccounts,
  renderChatChartOrEmpty,
  renderMemories,
  renderScope,
  renderTodayHuman,
  renderTodayIso,
  renderUserContext,
} from "./prompt-sections.js";

export interface ScanPromptOptions {
  fileName: string;
}

export interface ResolvePromptOptions {
  accountId?: string;
  from?: string;
  to?: string;
}

export interface RecordPromptOptions {
  utterance: string;
}

/**
 * Builders
 *
 * Each builder is a list of sections in render order. No accumulation, no
 * inline string assembly. To edit a section, change the helper; to reorder,
 * shuffle the array.
 */

export function buildChatSystemPrompt(db: Database.Database): string {
  const name = config.userName;
  return joinSections([
    chatPersona(name),
    renderTodayHuman(),
    renderUserContext(name, readContext()),
    renderChatChartOrEmpty(db, name),
    renderMemories(db, {
      header: `Things to remember about ${name}`,
      showCategory: true,
    }),
  ]);
}

export function buildResolveSystemPrompt(
  db: Database.Database,
  opts: ResolvePromptOptions,
): string {
  return joinSections([
    RESOLVE_PERSONA,
    renderTodayIso(),
    renderChartOfAccounts(db, { withBalance: true, emptyState: "resolve" }),
    renderScope(opts),
    renderMemories(db, {
      header: "Rules you've already learned (apply directly; do not re-ask the user)",
      showCategory: true,
    }),
  ]);
}

export function buildRecordSystemPrompt(
  db: Database.Database,
  opts: RecordPromptOptions,
): string {
  return joinSections([
    RECORD_PERSONA,
    renderTodayIso(),
    renderChartOfAccounts(db, { withBalance: true, emptyState: "scan" }),
    `## What the user said\n> ${opts.utterance.replace(/\n/g, " ")}`,
    renderMemories(db, {
      header: "Rules you've already learned (apply silently)",
      filterCategories: ["scanning_hint", "general", "preference"],
      showCategory: false,
    }),
  ]);
}

export function buildScanSystemPrompt(
  db: Database.Database,
  opts: ScanPromptOptions,
): string {
  return joinSections([
    SCAN_PERSONA,
    renderTodayIso(),
    renderChartOfAccounts(db, { withBalance: false, emptyState: "scan" }),
    `## File context\nFile: ${opts.fileName}`,
    `## Taxonomy hints\n${getThaiTaxonomyHint()}`,
    renderMemories(db, {
      header: "Rules you've already learned (apply silently before raising a question)",
      filterCategories: ["scanning_hint", "general"],
      showCategory: false,
    }),
  ]);
}

/** Drop null/empty sections, join the rest with a blank line. */
function joinSections(sections: Array<string | null | undefined>): string {
  return sections.filter((s): s is string => !!s).join("\n\n");
}
