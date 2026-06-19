import { createRequire } from "module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import {
  SKILL_MD,
  COMMANDS_REFERENCE_MD,
  SCHEMAS_MD,
  renderTaxonomyMd,
  AGENTS_MD_BLOCK,
  CODEX_BLOCK_RE,
} from "./templates.js";

/**
 * Installs the skill pack that lets external agent CLIs (Claude Code, codex)
 * drive the plasalid harness. Pure filesystem work — the CLI command wraps this
 * and maps thrown errors onto exit codes.
 */

export type InstallKind = "claude" | "codex";

export interface InstalledTarget {
  kind: InstallKind;
  path: string;
  version: string;
}

export interface InstallResult {
  installed: InstalledTarget[];
}

export interface InstallOptions {
  claude?: boolean;
  codex?: boolean;
  /** Install to the home dir (~/.claude) rather than the cwd (./.claude). */
  global?: boolean;
  /** Override the base directory: <dir>/skills/plasalid for claude, <dir>/AGENTS.md for codex. */
  dir?: string;
  /** Overwrite an installed skill dir whose VERSION differs. */
  force?: boolean;
}

/**
 * Thrown when a skill dir already exists at a DIFFERENT version and --force was
 * not given. The CLI maps this to exit code INVALID with a --force hint.
 */
export class SkillPackVersionError extends Error {
  readonly installedVersion: string;
  readonly cliVersion: string;
  readonly path: string;
  constructor(args: { installedVersion: string; cliVersion: string; path: string }) {
    super(
      `skill pack already installed at ${args.path} (version ${args.installedVersion}); ` +
        `this CLI is ${args.cliVersion}`,
    );
    this.name = "SkillPackVersionError";
    this.installedVersion = args.installedVersion;
    this.cliVersion = args.cliVersion;
    this.path = args.path;
  }
}

// install.ts compiles to dist/agent-setup/install.js; ../../package.json from
// there is the package root (same 2-level depth as src/cli/index.ts uses).
const require = createRequire(import.meta.url);

/** The CLI/package version the installed pack should be stamped with. */
export function getVersion(): string {
  const { version } = require("../../package.json") as { version: string };
  return version;
}

/** Absolute path to the Claude skill dir for the given options. */
function claudeSkillDir(opts: InstallOptions): string {
  const base = opts.dir
    ? resolve(opts.dir)
    : opts.global
      ? join(homedir(), ".claude")
      : join(process.cwd(), ".claude");
  return join(base, "skills", "plasalid");
}

/** Absolute path to the codex AGENTS.md for the given options. */
function codexAgentsPath(opts: InstallOptions): string {
  const base = opts.dir ? resolve(opts.dir) : process.cwd();
  return join(base, "AGENTS.md");
}

function readVersionFile(skillDir: string): string | null {
  const versionPath = join(skillDir, "VERSION");
  if (!existsSync(versionPath)) return null;
  return readFileSync(versionPath, "utf8").trim();
}

function installClaude(opts: InstallOptions, version: string): InstalledTarget {
  const skillDir = claudeSkillDir(opts);

  const existing = readVersionFile(skillDir);
  if (existing !== null && existing !== version && !opts.force) {
    throw new SkillPackVersionError({
      installedVersion: existing,
      cliVersion: version,
      path: skillDir,
    });
  }
  // existing === version -> silent idempotent overwrite; different + force -> overwrite.

  const referencesDir = join(skillDir, "references");
  mkdirSync(referencesDir, { recursive: true });

  writeFileSync(join(skillDir, "SKILL.md"), SKILL_MD(version));
  writeFileSync(join(referencesDir, "commands.md"), COMMANDS_REFERENCE_MD);
  writeFileSync(join(referencesDir, "schemas.md"), SCHEMAS_MD);
  writeFileSync(join(referencesDir, "taxonomy.md"), renderTaxonomyMd());
  writeFileSync(join(skillDir, "VERSION"), version + "\n");

  return { kind: "claude", path: skillDir, version };
}

function installCodex(opts: InstallOptions, version: string): InstalledTarget {
  const agentsPath = codexAgentsPath(opts);
  const block = AGENTS_MD_BLOCK(version);

  let next: string;
  if (existsSync(agentsPath)) {
    const current = readFileSync(agentsPath, "utf8");
    if (CODEX_BLOCK_RE.test(current)) {
      // Replace the existing block in place (any version) — keeps AGENTS.md free
      // of duplicate plasalid blocks across re-installs.
      next = current.replace(CODEX_BLOCK_RE, block);
    } else {
      const sep = current.endsWith("\n") ? "\n" : "\n\n";
      next = current + sep + block + "\n";
    }
  } else {
    mkdirSync(dirname(agentsPath), { recursive: true });
    next = block + "\n";
  }
  writeFileSync(agentsPath, next);

  return { kind: "codex", path: agentsPath, version };
}

/**
 * Install the skill pack. Defaults to Claude when neither target is requested.
 * Returns every target written. Throws SkillPackVersionError on a version clash
 * without --force.
 */
export function installSkillPack(opts: InstallOptions = {}): InstallResult {
  const version = getVersion();

  // Default target: claude.
  const wantClaude = opts.claude || (!opts.claude && !opts.codex);
  const wantCodex = !!opts.codex;

  const installed: InstalledTarget[] = [];
  if (wantClaude) installed.push(installClaude(opts, version));
  if (wantCodex) installed.push(installCodex(opts, version));
  return { installed };
}
