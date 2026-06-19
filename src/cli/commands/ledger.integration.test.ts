import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "libsql";

// ledger.integration.test.ts lives in src/cli/commands/ -> repo root is three
// levels up.
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
  tmpDir = mkdtempSync(join(tmpdir(), "plasalid-ledger-it-"));
  dbPath = join(tmpDir, "db.sqlite");
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  env.HOME = tmpDir;
  env.USERPROFILE = tmpDir;
  env.PLASALID_DB_PATH = dbPath;
  env.PLASALID_DATA_DIR = join(tmpDir, "data");
  env.PLASALID_CACHE_DIR = join(tmpDir, "cache");
  baseEnv = env;
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function runCli(args: string[]): Promise<CliResult> {
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
    child.stdin?.end();
  });
}

function parseNdjson(stdout: string): unknown[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseOne(stdout: string): any {
  const lines = stdout.trim().split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

describe("ledger CLI integration (subprocess)", () => {
  it(
    "accounts create -> list -> tree round-trip includes rollup math with one recorded tx",
    async () => {
      const bank = await runCli([
        "accounts",
        "create",
        "--id",
        "asset:bank",
        "--name",
        "Bank",
        "--type",
        "asset",
        "--parent",
        "asset",
        "--json",
      ]);
      expect(bank.code).toBe(0);
      expect(parseOne(bank.stdout)).toMatchObject({ id: "asset:bank", created: true });

      const groceries = await runCli([
        "accounts",
        "create",
        "--id",
        "expense:groceries",
        "--name",
        "Groceries",
        "--type",
        "expense",
        "--parent",
        "expense",
        "--json",
      ]);
      expect(groceries.code).toBe(0);
      expect(parseOne(groceries.stdout)).toMatchObject({
        id: "expense:groceries",
        created: true,
      });

      const txAdd = await runCli([
        "tx",
        "add",
        "--date",
        "2026-01-01",
        "--description",
        "Grocery run",
        "--amount",
        "100",
        "--debit-account",
        "expense:groceries",
        "--credit-account",
        "asset:bank",
        "--json",
      ]);
      expect(txAdd.code).toBe(0);
      const txResult = parseOne(txAdd.stdout);
      expect(txResult.transaction_id).toMatch(/^tx:/);

      const list = await runCli(["accounts", "list", "--json"]);
      expect(list.code).toBe(0);
      const rows = parseNdjson(list.stdout) as any[];
      const bankRow = rows.find((r) => r.id === "asset:bank");
      const groceriesRow = rows.find((r) => r.id === "expense:groceries");
      expect(bankRow?.balance).toBe(-100);
      expect(groceriesRow?.balance).toBe(100);

      const tree = await runCli(["accounts", "tree", "--json"]);
      expect(tree.code).toBe(0);
      const roots = parseOne(tree.stdout) as any[];
      const assetRoot = roots.find((r) => r.id === "asset");
      const expenseRoot = roots.find((r) => r.id === "expense");
      expect(assetRoot?.rollup).toBe(-100);
      expect(assetRoot?.children).toEqual([
        expect.objectContaining({ id: "asset:bank", balance: -100 }),
      ]);
      expect(expenseRoot?.rollup).toBe(100);
      expect(expenseRoot?.children).toEqual([
        expect.objectContaining({ id: "expense:groceries", balance: 100 }),
      ]);
    },
    60000,
  );

  it(
    "tx add strict mode: missing account fails NOT_FOUND (exit 5)",
    async () => {
      const result = await runCli([
        "tx",
        "add",
        "--date",
        "2026-01-02",
        "--description",
        "Bad account",
        "--amount",
        "10",
        "--debit-account",
        "expense:does-not-exist",
        "--credit-account",
        "asset:bank",
        "--json",
      ]);
      expect(result.code).toBe(5);
      expect(result.stdout.trim()).toBe("");
      const parsed = JSON.parse(result.stderr.trim());
      expect(parsed.error.code).toBe("E_NOT_FOUND");
    },
    30000,
  );

  it(
    "tx add --resolve creates a placeholder account and raises a question",
    async () => {
      const result = await runCli([
        "tx",
        "add",
        "--resolve",
        "--date",
        "2026-01-03",
        "--description",
        "New category test",
        "--amount",
        "20",
        "--debit-account",
        "expense:new-thing",
        "--credit-account",
        "asset:bank",
        "--json",
      ]);
      expect(result.code).toBe(0);
      const parsed = parseOne(result.stdout);
      expect(parsed.transaction_id).toMatch(/^tx:/);
      expect(parsed.raised_questions).toBe(1);

      const raw = new Database(dbPath);
      try {
        const account = raw
          .prepare("SELECT * FROM accounts WHERE id = ?")
          .get("expense:new-thing");
        expect(account).toBeTruthy();

        const question = raw
          .prepare("SELECT * FROM questions WHERE account_id = ? AND kind = 'uncategorized'")
          .get("expense:new-thing");
        expect(question).toBeTruthy();
      } finally {
        raw.close();
      }
    },
    30000,
  );

  it(
    "tx recategorize round-trip updates matching postings",
    async () => {
      const result = await runCli([
        "tx",
        "recategorize",
        "--filter-account",
        "expense:groceries",
        "--set-memo",
        "reviewed",
        "--json",
      ]);
      expect(result.code).toBe(0);
      const parsed = parseOne(result.stdout);
      expect(parsed.affected).toBe(1);
      expect(parsed.sample_posting_ids).toHaveLength(1);
    },
    30000,
  );

  it(
    "merchants upsert -> resolve -> set-default round-trip",
    async () => {
      const upsert = await runCli([
        "merchants",
        "upsert",
        "--name",
        "Starbucks",
        "--alias",
        "STARBUCKS #123 BKK",
        "--json",
      ]);
      expect(upsert.code).toBe(0);
      const merchant = parseOne(upsert.stdout);
      expect(merchant.canonical_name).toBe("Starbucks");
      expect(merchant.id).toMatch(/^m:/);

      const resolve_ = await runCli([
        "merchants",
        "resolve",
        "--descriptor",
        "Starbucks #456 Bangkok Charge",
        "--json",
      ]);
      expect(resolve_.code).toBe(0);
      const resolved = parseOne(resolve_.stdout);
      expect(resolved.found).toBe(true);
      expect(resolved.merchant_id).toBe(merchant.id);

      const setDefault = await runCli([
        "merchants",
        "set-default",
        "--merchant",
        merchant.id,
        "--account",
        "asset:bank",
        "--json",
      ]);
      expect(setDefault.code).toBe(0);
      const setDefaultResult = parseOne(setDefault.stdout);
      expect(setDefaultResult).toMatchObject({
        merchant_id: merchant.id,
        before: null,
        after: "asset:bank",
      });
    },
    45000,
  );
});
