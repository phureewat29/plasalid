import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "libsql";

// transactions.integration.test.ts lives in src/cli/commands/ -> repo root is
// three levels up.
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

describe("transactions CLI integration (subprocess)", () => {
  it(
    "accounts create -> list -> tree round-trip includes rollup math with one recorded transaction",
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

      const rec = await runCli([
        "transactions",
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
      expect(rec.code).toBe(0);
      const recResult = parseOne(rec.stdout);
      expect(recResult.transaction_id).toMatch(/^tx:/);

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
    "transactions add strict mode: missing account fails NOT_FOUND (exit 5)",
    async () => {
      const result = await runCli([
        "transactions",
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
    "transactions add --resolve creates a placeholder account and raises a question",
    async () => {
      const result = await runCli([
        "transactions",
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
    "transactions recategorize round-trip re-points matching transactions",
    async () => {
      const food = await runCli([
        "accounts",
        "create",
        "--id",
        "expense:food",
        "--name",
        "Food",
        "--type",
        "expense",
        "--parent",
        "expense",
        "--json",
      ]);
      expect(food.code).toBe(0);

      const result = await runCli([
        "transactions",
        "recategorize",
        "--filter-account",
        "expense:groceries",
        "--set-account",
        "expense:food",
        "--json",
      ]);
      expect(result.code).toBe(0);
      const parsed = parseOne(result.stdout);
      expect(parsed.affected).toBe(1);
      expect(parsed.skipped_self_transaction).toBe(0);
      expect(parsed.sample_transaction_ids).toHaveLength(1);

      // The transaction now touches expense:food, no longer expense:groceries.
      const listed = await runCli(["transactions", "list", "--account", "expense:food", "--json"]);
      expect(listed.code).toBe(0);
      const rows = parseNdjson(listed.stdout) as any[];
      expect(rows.some((r) => r.debit_account_id === "expense:food")).toBe(true);
    },
    45000,
  );

  it(
    "transactions show returns a transaction with amount rendered as a decimal",
    async () => {
      await runCli([
        "accounts", "create", "--id", "expense:coffee", "--name", "Coffee",
        "--type", "expense", "--parent", "expense", "--json",
      ]);

      const add = await runCli([
        "transactions", "add",
        "--debit-account", "expense:coffee",
        "--credit-account", "asset:bank",
        "--amount", "12.50",
        "--date", "2026-03-01",
        "--description", "flat white",
        "--json",
      ]);
      expect(add.code).toBe(0);
      const id = parseOne(add.stdout).transaction_id as string;
      expect(id).toMatch(/^tx:/);

      const show = await runCli(["transactions", "show", id, "--json"]);
      expect(show.code).toBe(0);
      const detail = parseOne(show.stdout);
      expect(detail).toMatchObject({
        id,
        description: "flat white",
        amount: 12.5,
        debit_account_id: "expense:coffee",
        credit_account_id: "asset:bank",
      });

      const missing = await runCli(["transactions", "show", "tx:nope", "--json"]);
      expect(missing.code).toBe(5);
      expect(JSON.parse(missing.stderr.trim()).error.code).toBe("E_NOT_FOUND");
    },
    45000,
  );

  it(
    "transactions dedupe groups same-amount / same-pair transactions",
    async () => {
      await runCli([
        "accounts", "create", "--id", "expense:tea", "--name", "Tea",
        "--type", "expense", "--parent", "expense", "--json",
      ]);

      const captured: string[] = [];
      for (const date of ["2026-04-01", "2026-04-02"]) {
        const add = await runCli([
          "transactions", "add",
          "--debit-account", "expense:tea",
          "--credit-account", "asset:bank",
          "--amount", "77",
          "--date", date,
          "--description", "matcha",
          "--json",
        ]);
        expect(add.code).toBe(0);
        captured.push(parseOne(add.stdout).transaction_id as string);
      }

      const dedupe = await runCli(["transactions", "dedupe", "--json"]);
      expect(dedupe.code).toBe(0);
      const objs = parseNdjson(dedupe.stdout) as any[];
      const summary = objs.find((o) => o.type === "summary");
      expect(summary.groups).toBeGreaterThanOrEqual(1);
      // The two tea rows (77.00, expense:tea -> asset:bank, one day apart) land
      // in one duplicate group; their ids appear among the emitted rows.
      const dupIds = objs.filter((o) => o.type !== "summary").map((r) => r.id);
      for (const id of captured) expect(dupIds).toContain(id);
    },
    45000,
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

  it(
    "merchants set-default --clear removes the default account; exactly one of --account/--clear is required",
    async () => {
      const upsert = await runCli(["merchants", "upsert", "--name", "Grab", "--json"]);
      expect(upsert.code).toBe(0);
      const merchant = parseOne(upsert.stdout);

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

      const cleared = await runCli([
        "merchants",
        "set-default",
        "--merchant",
        merchant.id,
        "--clear",
        "--json",
      ]);
      expect(cleared.code).toBe(0);
      expect(parseOne(cleared.stdout)).toMatchObject({
        merchant_id: merchant.id,
        before: "asset:bank",
        after: null,
      });

      const neither = await runCli([
        "merchants",
        "set-default",
        "--merchant",
        merchant.id,
        "--json",
      ]);
      expect(neither.code).toBe(2); // EXIT.USAGE

      const both = await runCli([
        "merchants",
        "set-default",
        "--merchant",
        merchant.id,
        "--account",
        "asset:bank",
        "--clear",
        "--json",
      ]);
      expect(both.code).toBe(2); // EXIT.USAGE
    },
    45000,
  );

  it(
    "accounts update: name only, metadata only, both, and none (USAGE)",
    async () => {
      const create = await runCli([
        "accounts",
        "create",
        "--id",
        "asset:wallet",
        "--name",
        "Wallet",
        "--type",
        "asset",
        "--parent",
        "asset",
        "--json",
      ]);
      expect(create.code).toBe(0);

      const nameOnly = await runCli([
        "accounts",
        "update",
        "asset:wallet",
        "--name",
        "Cash Wallet",
        "--json",
      ]);
      expect(nameOnly.code).toBe(0);
      expect(parseOne(nameOnly.stdout)).toMatchObject({
        id: "asset:wallet",
        name: "Cash Wallet",
        renamed: true,
      });

      const metadataOnly = await runCli([
        "accounts",
        "update",
        "asset:wallet",
        "--bank",
        "SCB",
        "--json",
      ]);
      expect(metadataOnly.code).toBe(0);
      const metaResult = parseOne(metadataOnly.stdout);
      expect(metaResult.changed).toBe(true);
      expect(metaResult.after.bank_name).toBe("SCB");
      expect(metaResult.renamed).toBeUndefined();

      const both = await runCli([
        "accounts",
        "update",
        "asset:wallet",
        "--name",
        "Main Wallet",
        "--points",
        "10",
        "--json",
      ]);
      expect(both.code).toBe(0);
      const bothResult = parseOne(both.stdout);
      expect(bothResult).toMatchObject({
        id: "asset:wallet",
        name: "Main Wallet",
        renamed: true,
        changed: true,
      });
      expect(bothResult.after.points_balance).toBe(10);

      const none = await runCli(["accounts", "update", "asset:wallet", "--json"]);
      expect(none.code).toBe(2); // EXIT.USAGE
      expect(JSON.parse(none.stderr.trim()).error.code).toBe("E_USAGE");
    },
    45000,
  );

  it(
    "accounts create with a 3-deep id and no --parent auto-creates missing ancestors",
    async () => {
      // "liability" is untouched by every earlier test in this file, so this
      // is a genuinely empty chain: the root and the middle category both
      // need to be created as a side effect of the leaf create.
      const result = await runCli([
        "accounts",
        "create",
        "--id",
        "liability:credit_card:ttb",
        "--name",
        "TTB Credit Card",
        "--type",
        "liability",
        "--json",
      ]);
      expect(result.code).toBe(0);
      expect(parseOne(result.stdout)).toMatchObject({
        id: "liability:credit_card:ttb",
        created: true,
        created_parents: ["liability", "liability:credit_card"],
      });

      const list = await runCli(["accounts", "list", "--json"]);
      const rows = parseNdjson(list.stdout) as any[];
      expect(rows.find((r) => r.id === "liability")).toMatchObject({ type: "liability" });
      expect(rows.find((r) => r.id === "liability:credit_card")).toMatchObject({
        type: "liability",
        parent_id: "liability",
      });
      expect(rows.find((r) => r.id === "liability:credit_card:ttb")).toMatchObject({
        name: "TTB Credit Card",
        parent_id: "liability:credit_card",
      });
    },
    30000,
  );

  it(
    "accounts create under an already-existing ancestor chain creates only the leaf",
    async () => {
      // "liability:credit_card" already exists from the previous test.
      const result = await runCli([
        "accounts",
        "create",
        "--id",
        "liability:credit_card:kbank",
        "--name",
        "KBank Credit Card",
        "--type",
        "liability",
        "--json",
      ]);
      expect(result.code).toBe(0);
      expect(parseOne(result.stdout)).toMatchObject({
        id: "liability:credit_card:kbank",
        created: true,
        created_parents: [],
      });
    },
    30000,
  );

  it(
    "accounts create with a type mismatch against an existing ancestor still fails INVALID",
    async () => {
      // "liability:credit_card" exists with type "liability"; requesting a
      // leaf under it with a mismatched --type must still fail cleanly, even
      // though the ancestor-walk itself doesn't need to create anything (it
      // already exists, so the walk silently skips it) — the mismatch is
      // caught by createAccount's own parent/type check on the leaf insert.
      const result = await runCli([
        "accounts",
        "create",
        "--id",
        "liability:credit_card:mismatch",
        "--name",
        "Mismatch",
        "--type",
        "asset",
        "--json",
      ]);
      expect(result.code).toBe(6); // EXIT.INVALID
      expect(result.stdout.trim()).toBe("");
      expect(JSON.parse(result.stderr.trim()).error.code).toBe("E_INVALID");
    },
    30000,
  );
});
