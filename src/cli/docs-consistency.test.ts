import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { buildProgram, COMMANDS } from "./program.js";
import { AGENTS_MD_BLOCK } from "../setup/codex.js";
import { ALL_THAI_INSTITUTIONS } from "../accounts/taxonomy.js";

/**
 * Drift-prevention test: no subprocesses, pure import + string parsing. Keeps
 * the program's real command tree, README.md's "## Commands" overview, the
 * checked-in agent skill (skills/SKILL.md), the codex AGENTS.md block, and the
 * root help screen's COMMANDS array from silently diverging as commands, flags,
 * or the Thai institution registry change.
 *
 * buildProgram() only constructs the commander tree — it never parses argv or
 * runs an action — so importing/calling it here is side-effect free.
 */

// docs-consistency.test.ts lives in src/cli/ -> repo root is two levels up.
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const README = readFileSync(resolve(repoRoot, "README.md"), "utf8");
const SKILL = readFileSync(resolve(repoRoot, "skills", "SKILL.md"), "utf8");

// The codex block is generated, not a file; render it with a throwaway version.
const CODEX_BLOCK = AGENTS_MD_BLOCK("0.0.0");

/**
 * Institution kinds SKILL.md lists as account leaves. Named here as a literal so
 * this test — not the doc or the registry — owns which kinds are account-forming.
 * Merchant-ish kinds (insurer/gov/telco/utility/payment_rail) are excluded: they
 * become merchants via `merchants upsert`, never account leaves.
 */
const ACCOUNT_FORMING_KINDS = ["bank", "card_issuer", "wallet", "broker", "crypto_exchange"];

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

/** True once brackets/pipes are stripped from the token's edges and what's left starts with `--`. */
function isFlagToken(token: string): boolean {
  return /^[[\]|]*--/.test(token);
}

/** True for a `<placeholder>` operand (also matches `"<why>"`-style quoted operands). */
function isArgToken(token: string): boolean {
  return token.includes("<");
}

/**
 * The concrete command noun a span names: the first token after `plasalid`, but
 * only when it is a real command word. A bare `plasalid`, a root flag
 * (`plasalid --version`), or a generic `plasalid <noun> --help` template names
 * no specific command and returns undefined.
 */
function commandNounOf(span: string): string | undefined {
  const noun = span.trim().split(/\s+/)[1];
  if (!noun || isFlagToken(noun) || isArgToken(noun)) return undefined;
  return noun;
}

/** Set of concrete command nouns mentioned across a markdown doc's plasalid spans. */
function extractSpanNouns(md: string): Set<string> {
  const nouns = new Set<string>();
  for (const span of extractPlasalidCodeSpans(md)) {
    const noun = commandNounOf(span);
    if (noun) nouns.add(noun);
  }
  return nouns;
}

/** The first bare (non-flag, non-placeholder) token after the noun, or undefined. */
function firstSubToken(span: string): string | undefined {
  const tokens = span.trim().split(/\s+/).filter(Boolean);
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i];
    if (isFlagToken(t) || isArgToken(t)) continue;
    return t.replace(/^[[\]|]+/, "").replace(/[[\]|]+$/, "");
  }
  return undefined;
}

/**
 * Resolve the command a doc code-span like `plasalid transactions recategorize --set-account <id> ...`
 * refers to: the top-level noun command, drilled into its subcommand when the
 * span names one (the first bare, non-flag, non-placeholder token after the noun).
 */
function resolveTargetCommand(program: Command, span: string): Command | undefined {
  const nounName = commandNounOf(span);
  if (!nounName) return undefined;
  const nounCmd = program.commands.find((c) => c.name() === nounName);
  if (!nounCmd) return undefined;
  if (nounCmd.commands.length === 0) return nounCmd;

  const sub = firstSubToken(span);
  if (!sub) return nounCmd;
  const child = nounCmd.commands.find((c) => c.name() === sub);
  return child ?? nounCmd;
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

describe("docs consistency (no subprocesses)", () => {
  it("program construction has no side effects (importing/building never touches argv)", () => {
    // If buildProgram() parsed argv or ran an action at import/construction
    // time, this bare call under vitest (whose own argv it would see) would
    // throw or hang. Merely reaching this assertion is the proof.
    expect(() => buildProgram()).not.toThrow();
  });

  it("top-level command names: program tree == README Commands section == SKILL.md spans == help-screen COMMANDS array", () => {
    const program = buildProgram();
    const fromProgram = new Set(topLevelNames(program));
    const fromReadme = extractReadmeCommandNames(README);
    const fromSkill = extractSpanNouns(SKILL);
    const fromCommandsArray = new Set(COMMANDS.map((c) => c.name));

    expect(fromReadme).toEqual(fromProgram);
    expect(fromSkill).toEqual(fromProgram);
    expect(fromCommandsArray).toEqual(fromProgram);
  });

  it("every subcommand named in a SKILL.md span resolves to a real subcommand (no silent fallback to the parent)", () => {
    const program = buildProgram();
    const problems: string[] = [];

    for (const span of extractPlasalidCodeSpans(SKILL)) {
      const noun = commandNounOf(span);
      if (!noun) continue;
      // Unknown nouns are the noun-set test's job; here we only vet the subcommand.
      const nounCmd = program.commands.find((c) => c.name() === noun);
      if (!nounCmd || nounCmd.commands.length === 0) continue;

      const sub = firstSubToken(span);
      if (!sub) continue; // span targets the parent noun (e.g. `plasalid config --generate-key`)
      const child = nounCmd.commands.find((c) => c.name() === sub);
      if (!child) problems.push(`\`${span}\` — \`${sub}\` is not a subcommand of \`${noun}\``);
    }
    expect(problems).toEqual([]);
  });

  it("every --flag on a plasalid span in SKILL.md and the codex block is a real option on the resolved command", () => {
    const program = buildProgram();
    const globalFlags = new Set(["--json", "--no-color"]);
    const problems: string[] = [];
    const sources: Array<[string, string]> = [
      ["SKILL.md", SKILL],
      ["codex block", CODEX_BLOCK],
    ];

    for (const [label, md] of sources) {
      for (const span of extractPlasalidCodeSpans(md)) {
        // Bare `plasalid`, root flags (`plasalid --version`), and generic
        // `plasalid <noun> --help` templates name no concrete command to check.
        if (!commandNounOf(span)) continue;
        const target = resolveTargetCommand(program, span);
        if (!target) {
          problems.push(`${label}: unresolvable command for \`${span}\``);
          continue;
        }
        const realFlags = new Set(target.options.map((o) => o.long).filter((f): f is string => !!f));
        for (const flag of extractFlagTokens(span)) {
          if (globalFlags.has(flag)) continue;
          if (!realFlags.has(flag)) {
            problems.push(`${label}: \`${span}\` — ${flag} is not an option on \`${target.name()}\``);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("SKILL.md Thai institution codes match the account-forming registry exactly (both directions)", () => {
    const expected = new Set(
      ALL_THAI_INSTITUTIONS.filter((inst) => ACCOUNT_FORMING_KINDS.includes(inst.kind)).map(
        (inst) => inst.code,
      ),
    );

    /** Codes are the backtick spans between the institution heading and the next heading. */
    const heading = "### Thai institution codes";
    const start = SKILL.indexOf(heading);
    expect(start).toBeGreaterThanOrEqual(0);
    const after = SKILL.slice(start + heading.length);
    const nextHeading = after.search(/\n#{1,6} /);
    const section = nextHeading === -1 ? after : after.slice(0, nextHeading);
    const inDoc = new Set([...section.matchAll(/`([^`]+)`/g)].map((m) => m[1]));

    // Sorted-array compare so a stale code AND a missing code both fail with a readable diff.
    expect([...inDoc].sort()).toEqual([...expected].sort());
  });

  it("SKILL.md stays under the size budget", () => {
    expect(SKILL.length).toBeLessThan(20_000);
  });

  it("SKILL.md and the codex block carry no references/ pointers", () => {
    expect(SKILL.includes("references/")).toBe(false);
    expect(CODEX_BLOCK.includes("references/")).toBe(false);
  });

  it("SKILL.md frontmatter has name + description and no version key", () => {
    const fm = SKILL.match(/^---\n([\s\S]*?)\n---/);
    expect(fm).not.toBeNull();
    const front = fm![1];
    expect(/^name:/m.test(front)).toBe(true);
    expect(/^description:/m.test(front)).toBe(true);
    expect(/^version:/m.test(front)).toBe(false);
  });
});
