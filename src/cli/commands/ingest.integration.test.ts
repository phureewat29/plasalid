import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
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

  // Migrate + seed real accounts so a "clean" transfer's sides resolve exactly
  // (rather than via placeholder creation). Closed before running the CLI so the
  // subprocess owns the writer.
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

describe("ingest commit v2 (subprocess)", () => {
  it("posts a clean transfer and a placeholder transfer, raises a question, exit 0", async () => {
    const ndjson = [
      JSON.stringify({
        date: "2026-01-02",
        description: "Groceries",
        debit_account: "expense:food",
        credit_account: "asset:cash",
        amount: 100,
      }),
      JSON.stringify({
        date: "2026-01-03",
        description: "Mystery charge",
        debit_account: "expense:totally-made-up-xyz",
        credit_account: "asset:cash",
        amount: 50,
      }),
    ].join("\n");

    const { stdout, code } = await runCli(["ingest", "commit", "--json"], { stdin: ndjson });
    expect(code).toBe(0);

    const objs = parseNdjson(stdout);
    const results = objs.filter((o) => o.type === "result");
    const summary = objs.find((o) => o.type === "summary");
    expect(results).toHaveLength(2);

    const [r0, r1] = results;

    // Clean transfer: both sides resolve exactly, no questions, no merchant.
    expect(r0.ok).toBe(true);
    expect(typeof r0.transfer_id).toBe("string");
    expect(r0.transfer_id).toMatch(/^tf:/);
    expect(r0.duplicate).toBe(false);
    expect(r0.raised_questions).toBe(0);
    expect(r0.merchant.how).toBe("none");
    expect(r0.sides).toEqual([
      { side: "debit", requested: "expense:food", resolved: "expense:food", how: "exact" },
      { side: "credit", requested: "asset:cash", resolved: "asset:cash", how: "exact" },
    ]);

    // Bogus account hint: a placeholder is created (valid top-level) -> 1 question.
    expect(r1.ok).toBe(true);
    expect(r1.raised_questions).toBe(1);
    expect(r1.sides[0]).toEqual({
      side: "debit",
      requested: "expense:totally-made-up-xyz",
      resolved: "expense:totally-made-up-xyz",
      how: "placeholder_created",
    });
    expect(r1.sides[1].how).toBe("exact");

    expect(summary).toBeDefined();
    expect(summary.batch_id).toMatch(/^sc:/);
    expect(summary.posted).toBe(2);
    expect(summary.duplicates).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.raised_questions).toBe(1);

    // The question was actually written, scoped to this batch's scan id.
    const db = readDb();
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM questions WHERE scan_id = ?").get(summary.batch_id) as {
        n: number;
      }
    ).n;
    db.close();
    expect(n).toBe(1);
  }, 30000);

  it("reads the batch from a file via --input (agent file-staging path)", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "plasalid-input-"));
    const inputPath = join(dir, "batch.ndjson");
    writeFileSync(
      inputPath,
      JSON.stringify({
        date: "2026-01-05",
        description: "Staged via file",
        debit_account: "expense:food",
        credit_account: "asset:cash",
        amount: 42,
      }) + "\n",
    );

    const { stdout, code } = await runCli(["ingest", "commit", "--input", inputPath, "--json"]);
    expect(code).toBe(0);
    const objs = parseNdjson(stdout);
    expect(objs.find((o) => o.type === "summary")?.posted).toBe(1);

    const missing = await runCli(["ingest", "commit", "--input", join(dir, "nope.ndjson"), "--json"]);
    expect(missing.code).toBe(5);
  });

  it("returns exit 7 (PARTIAL) when one item is valid and one is dirty", async () => {
    const ndjson = [
      JSON.stringify({
        date: "2026-02-01",
        description: "Valid",
        debit_account: "expense:food",
        credit_account: "asset:cash",
        amount: 20,
      }),
      JSON.stringify({
        date: "2026-02-02",
        description: "Dirty",
        debit_account: "expense:food",
        credit_account: "expense:food",
        amount: 5,
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
        debit_account: "expense:food",
        credit_account: "asset:cash",
        amount: 20,
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

  it("is idempotent: a second commit of the same row reports duplicate:true, balance unchanged", async () => {
    const db = readDb();
    db.prepare(
      `INSERT INTO scanned_files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, 'pending')`,
    ).run("sf:idem", "/tmp/idem.pdf", "idem-hash", "application/pdf");
    db.close();

    const item = JSON.stringify({
      date: "2026-03-01",
      description: "Rent",
      debit_account: "expense:food",
      credit_account: "asset:cash",
      amount: 1000,
      row_index: 0,
    });

    const first = await runCli(["ingest", "commit", "--file", "sf:idem", "--json"], { stdin: item });
    expect(first.code).toBe(0);
    const firstObjs = parseNdjson(first.stdout);
    expect(firstObjs.find((o) => o.type === "result").duplicate).toBe(false);
    const firstSummary = firstObjs.find((o) => o.type === "summary");
    expect(firstSummary.posted).toBe(1);
    expect(firstSummary.duplicates).toBe(0);

    const second = await runCli(["ingest", "commit", "--file", "sf:idem", "--json"], { stdin: item });
    expect(second.code).toBe(0); // duplicates are a successful no-op
    const secondObjs = parseNdjson(second.stdout);
    const secondResult = secondObjs.find((o) => o.type === "result");
    expect(secondResult.ok).toBe(true);
    expect(secondResult.duplicate).toBe(true);
    const secondSummary = secondObjs.find((o) => o.type === "summary");
    expect(secondSummary.posted).toBe(0);
    expect(secondSummary.duplicates).toBe(1);
    expect(secondSummary.failed).toBe(0);

    // Exactly one transfer for this file survived (idempotent insert).
    const db2 = readDb();
    const n = (
      db2.prepare("SELECT COUNT(*) AS n FROM transfers WHERE source_file_id = 'sf:idem'").get() as {
        n: number;
      }
    ).n;
    db2.close();
    expect(n).toBe(1);
  }, 45000);

  it("commits a compound (linked) salary split under one shared group", async () => {
    const db = readDb();
    createAccount(db, { id: "asset:bank", name: "Bank", type: "asset", parent_id: "asset" });
    createAccount(db, { id: "income:salary", name: "Salary", type: "income", parent_id: "income" });
    createAccount(db, { id: "expense:tax", name: "Tax", type: "expense", parent_id: "expense" });
    db.close();

    const item = JSON.stringify({
      date: "2026-04-25",
      description: "Salary",
      linked: [
        { debit_account: "asset:bank", credit_account: "income:salary", amount: 4500, description: "Net pay" },
        { debit_account: "expense:tax", credit_account: "income:salary", amount: 500, description: "Withholding" },
      ],
    });

    const { stdout, code } = await runCli(["ingest", "commit", "--json"], { stdin: item });
    expect(code).toBe(0);

    const objs = parseNdjson(stdout);
    const r = objs.find((o) => o.type === "result");
    expect(r.ok).toBe(true);
    expect(r.group_id).toMatch(/^tg:/);
    expect(r.legs).toHaveLength(2);
    expect(r.legs.every((l: any) => /^tf:/.test(l.transfer_id))).toBe(true);
    expect(r.duplicate).toBe(false);

    const db2 = readDb();
    const rows = db2.prepare("SELECT id FROM transfers WHERE group_id = ?").all(r.group_id);
    db2.close();
    expect(rows).toHaveLength(2);
  }, 30000);

  it("rejects a cross-currency transfer with a currency_mismatch question", async () => {
    const db = readDb();
    createAccount(db, {
      id: "asset:usd",
      name: "USD Wallet",
      type: "asset",
      parent_id: "asset",
      currency: "USD",
    });
    db.close();

    const item = JSON.stringify({
      date: "2026-05-01",
      description: "FX move",
      debit_account: "expense:food",
      credit_account: "asset:usd",
      amount: 10,
    });

    const { stdout, code } = await runCli(["ingest", "commit", "--json"], { stdin: item });
    expect(code).toBe(7);

    const objs = parseNdjson(stdout);
    const r = objs.find((o) => o.type === "result");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("currency_mismatch");
    const summary = objs.find((o) => o.type === "summary");
    expect(summary.failed).toBe(1);

    const db2 = readDb();
    const q = db2.prepare("SELECT * FROM questions WHERE kind = 'currency_mismatch'").get();
    db2.close();
    expect(q).toBeTruthy();
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

describe("ingest fail (subprocess)", () => {
  it("purges the file's raster cache and reports cache_removed", async () => {
    const fileId = "sf:cache-test";
    const db = readDb();
    try {
      db.prepare(
        `INSERT INTO scanned_files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, 'pending')`,
      ).run(fileId, "/tmp/cache-test.pdf", "cache-test-hash", "application/pdf");
    } finally {
      db.close();
    }

    // cleanCache resolves PLASALID_CACHE_DIR/<fileId>; precreate it so the
    // subprocess has something real to remove (mirrors what `ingest prepare`
    // would have left behind, without needing an actual PDF fixture here).
    const cacheSubdir = join(tmpDir, "cache", fileId);
    mkdirSync(cacheSubdir, { recursive: true });
    writeFileSync(join(cacheSubdir, "page-1.png"), "fake png bytes");
    expect(existsSync(cacheSubdir)).toBe(true);

    const { stdout, code } = await runCli([
      "ingest",
      "fail",
      fileId,
      "--error",
      "unreadable statement",
      "--json",
    ]);
    expect(code).toBe(0);
    const result = JSON.parse(stdout.trim());
    expect(result.status).toBe("failed");
    expect(result.cache_removed).toEqual([cacheSubdir]);
    expect(existsSync(cacheSubdir)).toBe(false);
  }, 30000);
});
