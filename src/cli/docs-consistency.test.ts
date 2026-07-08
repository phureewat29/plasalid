import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { buildProgram, COMMANDS } from "./program.js";
import { COMMANDS_REFERENCE_MD } from "../setup/templates.js";

/**
 * Drift-prevention test: no subprocesses, pure import + string parsing. Keeps
 * the program's real command tree, README.md's "## Commands" overview, the
 * setup skill pack's COMMANDS_REFERENCE_MD, and the root help screen's
 * COMMANDS array from silently diverging as commands/flags are added, renamed,
 * or removed.
 *
 * buildProgram() only constructs the commander tree — it never parses argv or
 * runs an action — so importing/calling it here is side-effect free.
 */

// docs-consistency.test.ts lives in src/cli/ -> repo root is two levels up.
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const README = readFileSync(resolve(repoRoot, "README.md"), "utf8");

function topLevelNames(program: Command): string[] {
  // Aliases (e.g. `data`'s `open`) live on the same Command instance, not as
  // a separate entry in `program.commands`, so no explicit alias filtering
  // is needed here.
  return program.commands.map((c) => c.name());
}

/** Pull the fenced code block out of README's "## Commands" section. */
function readmeCommandsBlock(readme: string): string {
  const startIdx = readme.indexOf("\n## Commands\n");
  if (startIdx === -1) throw new Error('README.md is missing a "## Commands" section');
  const rest = readme.slice(startIdx);
  const nextHeadingIdx = rest.slice(1).search(/\n## /);
  const section = nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx + 1);
  const fenceMatch = section.match(/```([\s\S]*?)```/);
  if (!fenceMatch) throw new Error('README.md "## Commands" section has no fenced code block');
  return fenceMatch[1];
}

/**
 * Extract the noun named on each `plasalid <noun> ...` line of the README's
 * grouped overview. The bare `plasalid` line (no noun token before the `#`
 * comment) documents the no-arg default action, which is an alias for the
 * `status` command — mapped explicitly rather than left unmatched.
 */
function extractReadmeCommandNames(readme: string): Set<string> {
  const block = readmeCommandsBlock(readme);
  const names = new Set<string>();
  for (const rawLine of block.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("plasalid")) continue;
    const beforeComment = trimmed.split("#")[0].trim();
    const parts = beforeComment.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      names.add("status"); // bare `plasalid` line == the status default action
      continue;
    }
    names.add(parts[1]);
  }
  return names;
}

/** All `` `plasalid ...` `` backtick spans anywhere in a markdown string. */
function extractPlasalidCodeSpans(md: string): string[] {
  const spans: string[] = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    if (m[1].startsWith("plasalid ") || m[1] === "plasalid") spans.push(m[1]);
  }
  return spans;
}

/** The noun (first token after `plasalid`) of a single code span. */
function nounOf(span: string): string | undefined {
  return span.trim().split(/\s+/)[1];
}

function extractReferenceMdNouns(md: string): Set<string> {
  const nouns = new Set<string>();
  for (const span of extractPlasalidCodeSpans(md)) {
    const noun = nounOf(span);
    if (noun) nouns.add(noun);
  }
  return nouns;
}

/** True once brackets/pipes are stripped from the token's edges and what's left starts with `--`. */
function isFlagToken(token: string): boolean {
  return /^[[\]|]*--/.test(token);
}

function isArgToken(token: string): boolean {
  return token.includes("<");
}

/**
 * Resolve the command a doc code-span like `plasalid tx recategorize --set-account <id> ...`
 * refers to: the top-level noun command, drilled into its subcommand when the
 * span names one (the first bare, non-flag, non-arg token right after the noun).
 */
function resolveTargetCommand(program: Command, span: string): Command | undefined {
  const tokens = span.trim().split(/\s+/).filter(Boolean);
  const nounName = tokens[1];
  const nounCmd = program.commands.find((c) => c.name() === nounName);
  if (!nounCmd) return undefined;
  if (nounCmd.commands.length === 0) return nounCmd;

  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i];
    if (isFlagToken(t) || isArgToken(t)) continue;
    const bare = t.replace(/^[[\]|]+/, "").replace(/[[\]|]+$/, "");
    const child = nounCmd.commands.find((c) => c.name() === bare);
    return child ?? nounCmd;
  }
  return nounCmd;
}

/** Every `--flag` token mentioned in a code span (brackets/pipes/values stripped). */
function extractFlagTokens(span: string): string[] {
  const tokens = span.trim().split(/\s+/).filter(Boolean);
  const flags: string[] = [];
  for (const t of tokens) {
    if (!isFlagToken(t)) continue;
    const bare = t.replace(/^[[\]|]+/, "").replace(/[[\]|]+$/, "");
    if (bare.startsWith("--")) flags.push(bare);
  }
  return flags;
}

function allCommandNodes(cmd: Command): Command[] {
  return [cmd, ...cmd.commands.flatMap((c) => allCommandNodes(c))];
}

describe("docs consistency (no subprocesses)", () => {
  it("program construction has no side effects (importing/building never touches argv)", () => {
    // If buildProgram() parsed argv or ran an action at import/construction
    // time, this bare call under vitest (whose own argv it would see) would
    // throw or hang. Merely reaching this assertion is the proof.
    expect(() => buildProgram()).not.toThrow();
  });

  it("top-level command names: program tree == README Commands section == COMMANDS_REFERENCE_MD nouns == help-screen COMMANDS array", () => {
    const program = buildProgram();
    const fromProgram = new Set(topLevelNames(program));
    const fromReadme = extractReadmeCommandNames(README);
    const fromReference = extractReferenceMdNouns(COMMANDS_REFERENCE_MD);
    const fromCommandsArray = new Set(COMMANDS.map((c) => c.name));

    expect(fromReadme).toEqual(fromProgram);
    expect(fromReference).toEqual(fromProgram);
    expect(fromCommandsArray).toEqual(fromProgram);
  });

  it("every subcommand name in the program tree appears somewhere in COMMANDS_REFERENCE_MD", () => {
    const program = buildProgram();
    const allNodes = program.commands.flatMap((c) => allCommandNodes(c));
    const missing: string[] = [];
    for (const node of allNodes) {
      const name = node.name();
      const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (!re.test(COMMANDS_REFERENCE_MD)) missing.push(`${node.parent?.name()}.${name}`);
    }
    expect(missing).toEqual([]);
  });

  it("every --flag documented on a `plasalid <noun> [<sub>]` line in COMMANDS_REFERENCE_MD is a real option on that command", () => {
    const program = buildProgram();
    const globalFlags = new Set(["--json", "--no-color"]);
    const problems: string[] = [];

    for (const span of extractPlasalidCodeSpans(COMMANDS_REFERENCE_MD)) {
      // A bare `plasalid` mention (no noun) — e.g. "the no-arg default
      // (`plasalid`)" — names no command and carries no flags to check.
      if (span.trim().split(/\s+/).length < 2) continue;
      const target = resolveTargetCommand(program, span);
      if (!target) {
        problems.push(`unresolvable command for doc line: \`${span}\``);
        continue;
      }
      const realFlags = new Set(target.options.map((o) => o.long).filter((f): f is string => !!f));
      for (const flag of extractFlagTokens(span)) {
        if (globalFlags.has(flag)) continue;
        if (!realFlags.has(flag)) {
          problems.push(`\`${span}\` — ${flag} is not a real option on \`${target.name()}\``);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
