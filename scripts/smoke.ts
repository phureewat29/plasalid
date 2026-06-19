/**
 * Non-TTY smoke test for the deterministic CLI harness.
 *
 * Spawns `node dist/cli/index.js <cmd> --json` for every read-only command
 * variant against a throwaway environment (temp HOME + temp
 * PLASALID_DB_PATH/DATA_DIR/CACHE_DIR), so nothing touches the real
 * ~/.plasalid. For each case it asserts:
 *   - stdout is valid NDJSON (every non-empty line parses as JSON)
 *   - stderr JSON-parses when non-empty
 *   - the exit code matches what's expected
 *   - no ANSI escape bytes (\x1b) appear anywhere in stdout/stderr
 *
 * Run via `npx tsx scripts/smoke.ts` (also wired up as `npm run smoke`,
 * which builds first). This file builds `dist/` itself too, so a direct
 * `tsx scripts/smoke.ts` invocation is self-sufficient.
 */
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CLI_PATH = join(REPO_ROOT, "dist", "cli", "index.js");

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b/;

interface Case {
  label: string;
  args: string[];
  expectExit?: number;
}

const CASES: Case[] = [
  { label: "status", args: ["status"] },
  { label: "doctor", args: ["doctor"] },
  { label: "config show", args: ["config", "show"] },
  { label: "config path", args: ["config", "path"] },
  { label: "ingest list", args: ["ingest", "list"] },
  { label: "files list", args: ["files", "list"] },
  { label: "vault list", args: ["vault", "list"] },
  { label: "postings list", args: ["postings", "list"] },
  { label: "postings search --query x", args: ["postings", "search", "--query", "x"] },
  { label: "accounts list", args: ["accounts", "list"] },
  { label: "accounts tree", args: ["accounts", "tree"] },
  { label: "merchants list", args: ["merchants", "list"] },
  { label: "questions list", args: ["questions", "list"] },
  { label: "report net-worth", args: ["report", "net-worth"] },
  {
    label: "report period",
    args: ["report", "period", "--from", "2026-01-01", "--to", "2026-01-31"],
  },
  { label: "analyze duplicates", args: ["analyze", "duplicates"] },
  { label: "analyze correlations", args: ["analyze", "correlations"] },
  { label: "notes list", args: ["notes", "list"] },
  { label: "taxonomy", args: ["taxonomy"] },
  { label: "context show", args: ["context", "show"] },
  {
    label: "tx show tx:nonexistent",
    args: ["tx", "show", "tx:nonexistent"],
    expectExit: 5,
  },
];

interface Result {
  label: string;
  pass: boolean;
  detail: string;
}

/** Every non-empty line must parse as JSON on its own (NDJSON). */
function checkNdjson(text: string): string | null {
  const lines = text.split("\n").filter((l) => l.length > 0);
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      return `invalid JSON line: ${line.slice(0, 200)}`;
    }
  }
  return null;
}

function setUpTempEnv(): { env: NodeJS.ProcessEnv; root: string } {
  const root = mkdtempSync(join(tmpdir(), "plasalid-smoke-"));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const cacheDir = join(root, "cache");
  const dbPath = join(root, "db.sqlite");
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // config.ts derives ~/.plasalid from os.homedir(); redirect that away
    // from the real home so config.json/context.md are never touched.
    HOME: home,
    USERPROFILE: home,
    PLASALID_DB_PATH: dbPath,
    PLASALID_DATA_DIR: dataDir,
    PLASALID_CACHE_DIR: cacheDir,
    // Blank out any encryption key inherited from the real shell/.env so the
    // throwaway db is always plain and reproducible.
    PLASALID_DB_ENCRYPTION_KEY: "",
    NO_COLOR: "1",
  };
  return { env, root };
}

function runCase(c: Case, env: NodeJS.ProcessEnv, cwd: string): Result {
  const expectExit = c.expectExit ?? 0;
  const res = spawnSync(process.execPath, [CLI_PATH, ...c.args, "--json"], {
    cwd,
    env,
    encoding: "utf8",
  });

  if (res.error) return { label: c.label, pass: false, detail: `spawn error: ${res.error.message}` };

  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  const problems: string[] = [];

  if (res.status !== expectExit) {
    problems.push(`exit ${res.status} (expected ${expectExit})`);
  }

  const stdoutErr = checkNdjson(stdout);
  if (stdoutErr) problems.push(`stdout: ${stdoutErr}`);

  if (stderr.trim().length > 0) {
    const stderrErr = checkNdjson(stderr);
    if (stderrErr) problems.push(`stderr: ${stderrErr}`);
  }

  if (ANSI_RE.test(stdout) || ANSI_RE.test(stderr)) {
    problems.push("ANSI escape bytes present");
  }

  return { label: c.label, pass: problems.length === 0, detail: problems.join("; ") };
}

function printTable(results: Result[]): void {
  const width = Math.max(...results.map((r) => r.label.length));
  for (const r of results) {
    const status = r.pass ? "PASS" : "FAIL";
    const line = `${status.padEnd(4)}  ${r.label.padEnd(width)}  ${r.detail}`;
    console.log(line.trimEnd());
  }
}

function main(): void {
  console.log("smoke: building...");
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "inherit" });

  const { env, root } = setUpTempEnv();
  console.log(`smoke: temp env at ${root}`);

  try {
    const results = CASES.map((c) => runCase(c, env, root));
    console.log("");
    printTable(results);
    console.log("");

    const failed = results.filter((r) => !r.pass);
    if (failed.length > 0) {
      console.error(`smoke: ${failed.length}/${results.length} case(s) failed`);
      process.exit(1);
    }
    console.log(`smoke: all ${results.length} cases passed`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
