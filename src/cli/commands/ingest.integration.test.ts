import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "libsql";
import { migrate } from "../../db/schema.js";
import { createAccount } from "../../db/queries/account-balance.js";

// This test lives in src/cli/commands/ -> repo root is three levels up.
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

let tmpDir: string;
let dbPath: string;
let baseEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "plasalid-ingest-it-"));
  dbPath = join(tmpDir, "db.sqlite");
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  delete env.PLASALID_DB_ENCRYPTION_KEY; // unencrypted so the test can read the db directly
  env.HOME = tmpDir;
  env.USERPROFILE = tmpDir;
  env.PLASALID_DB_PATH = dbPath;
  env.PLASALID_DATA_DIR = join(tmpDir, "data");
  env.PLASALID_CACHE_DIR = join(tmpDir, "cache");
  baseEnv = env;

  // Migrate + seed real accounts so the "clean" transaction's postings resolve
  // exactly (rather than via placeholder creation). Closed before running the
  // CLI so the subprocess owns the writer.
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "asset:cash", name: "Cash", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  db.close();
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function runCli(args: string[], opts: { stdin?: string } = {}): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      "npx",
      ["tsx", "src/cli/index.ts", ...args],
      {
        cwd: repoRoot,
        env: baseEnv,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
    if (opts.stdin != null) child.stdin?.write(opts.stdin);
    child.stdin?.end();
  });
}

function parseNdjson(stdout: string): any[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readDb(): Database.Database {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}

describe("ingest commit (subprocess)", () => {
  it("posts a clean tx and a placeholder tx, actually raises a question, exit 0", async () => {
    const ndjson = [
      JSON.stringify({
        date: "2026-01-02",
        description: "Groceries",
        postings: [
          { account_id: "expense:food", debit: 100 },
          { account_id: "asset:cash", credit: 100 },
        ],
      }),
      JSON.stringify({
        date: "2026-01-03",
        description: "Mystery charge",
        postings: [
          { account_id: "expense:totally-made-up-xyz", debit: 50 },
          { account_id: "asset:cash", credit: 50 },
        ],
      }),
    ].join("\n");

    const { stdout, code } = await runCli(["ingest", "commit", "--json"], { stdin: ndjson });
    expect(code).toBe(0);

    const objs = parseNdjson(stdout);
    const results = objs.filter((o) => o.type === "result");
    const summary = objs.find((o) => o.type === "summary");
    expect(results).toHaveLength(2);

    const [r0, r1] = results;

    // Clean tx: both postings resolve exactly, no questions, no merchant.
    expect(r0.ok).toBe(true);
    expect(typeof r0.transaction_id).toBe("string");
    expect(r0.raised_questions).toBe(0);
    expect(r0.merchant.how).toBe("none");
    expect(r0.postings).toEqual([
      { index: 0, requested: "expense:food", resolved: "expense:food", how: "exact" },
      { index: 1, requested: "asset:cash", resolved: "asset:cash", how: "exact" },
    ]);

    // Bogus account hint: placeholder created (valid top-level) -> raises 1 question.
    expect(r1.ok).toBe(true);
    expect(r1.raised_questions).toBe(1);
    expect(r1.postings[0]).toEqual({
      index: 0,
      requested: "expense:totally-made-up-xyz",
      resolved: "expense:totally-made-up-xyz",
      how: "placeholder_created",
    });
    expect(r1.postings[1].how).toBe("exact");

    expect(summary).toBeDefined();
    expect(summary.batch_id).toMatch(/^sc:/);
    expect(summary.posted).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.raised_questions).toBe(1);

    // The question was actually written to the db, scoped to this batch's scan id.
    const db = readDb();
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM questions WHERE scan_id = ?").get(summary.batch_id) as {
        n: number;
      }
    ).n;
    db.close();
    expect(n).toBe(1);
  }, 30000);

  it("returns exit 7 (PARTIAL) when one item is valid and one is dirty", async () => {
    const ndjson = [
      JSON.stringify({
        date: "2026-02-01",
        description: "Valid",
        postings: [
          { account_id: "expense:food", debit: 20 },
          { account_id: "asset:cash", credit: 20 },
        ],
      }),
      JSON.stringify({
        date: "2026-02-02",
        description: "Dirty",
        postings: [{ account_id: "expense:food", debit: 0, credit: 0 }],
      }),
    ].join("\n");

    const { stdout, code } = await runCli(["ingest", "commit", "--json"], { stdin: ndjson });
    expect(code).toBe(7);

    const objs = parseNdjson(stdout);
    const results = objs.filter((o) => o.type === "result");
    const summary = objs.find((o) => o.type === "summary");

    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].reason).toBe("dirty_input");
    expect(typeof results[1].message).toBe("string");
    expect(summary.posted).toBe(1);
    expect(summary.failed).toBe(1);
  }, 30000);

  it("an item without a date is a clean dirty_input failure, not a raw SQL error", async () => {
    const ndjson = [
      JSON.stringify({
        description: "Missing date",
        postings: [
          { account_id: "expense:food", debit: 20 },
          { account_id: "asset:cash", credit: 20 },
        ],
      }),
    ].join("\n");

    const { stdout, stderr, code } = await runCli(["ingest", "commit", "--json"], { stdin: ndjson });
    expect(code).toBe(7); // EXIT.PARTIAL

    const objs = parseNdjson(stdout);
    const results = objs.filter((o) => o.type === "result");
    const summary = objs.find((o) => o.type === "summary");

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].reason).toBe("dirty_input");
    expect(results[0].message).toMatch(/ISO date/);
    expect(summary.posted).toBe(0);
    expect(summary.failed).toBe(1);

    expect(stderr).not.toMatch(/SQLITE|SQL error/i);
  }, 30000);

  it("fails with USAGE when stdin has no transaction data", async () => {
    const { stdout, stderr, code } = await runCli(["ingest", "commit", "--json"], { stdin: "" });
    expect(code).toBe(2); // EXIT.USAGE
    expect(stdout.trim()).toBe("");
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.error.code).toBe("E_USAGE");
  }, 30000);
});

describe("vault (subprocess)", () => {
  it("add/list/rm round-trips via --password-stdin without leaking plaintext", async () => {
    const pattern = "^kbank-.*";

    const add = await runCli(["vault", "add", pattern, "--password-stdin", "--json"], {
      stdin: "hunter2",
    });
    expect(add.code).toBe(0);
    const addObj = JSON.parse(add.stdout.trim());
    expect(addObj.pattern).toBe(pattern);
    expect(typeof addObj.id).toBe("string");

    const list = await runCli(["vault", "list", "--json"]);
    expect(list.code).toBe(0);
    const rows = parseNdjson(list.stdout);
    const row = rows.find((r) => r.pattern === pattern);
    expect(row).toBeDefined();
    // Never exposes the password (neither plaintext nor the encrypted column).
    expect(JSON.stringify(row)).not.toContain("hunter2");
    expect(row.password_encrypted).toBeUndefined();

    const rm = await runCli(["vault", "rm", pattern, "--yes", "--json"]);
    expect(rm.code).toBe(0);
    expect(JSON.parse(rm.stdout.trim()).removed).toBe(true);

    const list2 = await runCli(["vault", "list", "--json"]);
    const rows2 = parseNdjson(list2.stdout);
    expect(rows2.find((r) => r.pattern === pattern)).toBeUndefined();
  }, 30000);

  it("rm of a missing entry (with --yes) exits NOT_FOUND (5)", async () => {
    const { code, stderr } = await runCli(["vault", "rm", "does-not-exist", "--yes", "--json"]);
    expect(code).toBe(5); // EXIT.NOT_FOUND
    expect(JSON.parse(stderr.trim()).error.code).toBe("E_NOT_FOUND");
  }, 30000);
});
