import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../../db/schema.js";
import { accountIngestTools, scanQuestionTools } from "./ingest.js";
import { createAccount, findAccountById } from "../../db/queries/account-balance.js";
import { listQuestions } from "../../db/queries/questions.js";
import { createProgress } from "../../scanner/progress.js";
import type { AgentExecutionContext } from "./types.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "liability", name: "Liabilities", type: "liability", parent_id: null });
  createAccount(db, { id: "income", name: "Income", type: "income", parent_id: null });
  createAccount(db, { id: "asset:kbank", name: "KBank Savings", type: "asset", parent_id: "asset", subtype: "bank", bank_name: "kbank" });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense", subtype: "groceries" });
  return db;
}

function ctx(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return { interactive: false, ...overrides };
}

describe("accountIngestTools — DB writes", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("create_account inserts a row", async () => {
    const res = await accountIngestTools.execute(db, "create_account", {
      id: "income:salary",
      name: "Salary",
      type: "income",
      parent_id: "income",
    }, ctx());
    expect(res).toMatch(/Account created/);
    expect(findAccountById(db, "income:salary")).toBeTruthy();
  });

  it("record_transaction posts a balanced transaction", async () => {
    const res = await accountIngestTools.execute(db, "record_transaction", {
      date: "2026-05-19",
      description: "Coffee",
      postings: [
        { account_id: "expense:food", debit: 100 },
        { account_id: "asset:kbank", credit: 100 },
      ],
    }, ctx());
    expect(res).toMatch(/Posted transaction/);
    const rows = db.prepare(`SELECT id, date, description FROM transactions`).all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe("Coffee");
  });

  it("record_transaction with embedded merchant upserts merchant atomically", async () => {
    await accountIngestTools.execute(db, "record_transaction", {
      date: "2026-05-19",
      description: "Coffee at Starbucks",
      raw_descriptor: "STARBUCKS #1234 BKK",
      merchant: { canonical_name: "Starbucks", alias: "STARBUCKS #1234 BKK", default_account_id: "expense:food" },
      postings: [
        { account_id: "expense:food", debit: 120 },
        { account_id: "asset:kbank", credit: 120 },
      ],
    }, ctx());
    const merchant = db.prepare(`SELECT id, canonical_name, default_account_id FROM merchants`).get() as { id: string; canonical_name: string; default_account_id: string };
    expect(merchant.canonical_name).toBe("Starbucks");
    expect(merchant.default_account_id).toBe("expense:food");
    const tx = db.prepare(`SELECT merchant_id, raw_descriptor FROM transactions`).get() as { merchant_id: string; raw_descriptor: string };
    expect(tx.merchant_id).toBe(merchant.id);
    expect(tx.raw_descriptor).toBe("STARBUCKS #1234 BKK");
  });

  it("create_account rejects parent/type mismatch", async () => {
    const res = await accountIngestTools.execute(db, "create_account", {
      id: "expense:cash",
      name: "Cash (wrong type)",
      type: "asset",
      parent_id: "expense",
    }, ctx());
    expect(res).toMatch(/does not match parent/);
  });
});

describe("accountIngestTools — record_transactions (batch)", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  function buildTx(overrides: Partial<{ date: string; description: string; debit: number; account: string }> = {}) {
    return {
      date: overrides.date ?? "2026-05-19",
      description: overrides.description ?? "Coffee",
      postings: [
        { account_id: overrides.account ?? "expense:food", debit: overrides.debit ?? 100 },
        { account_id: "asset:kbank", credit: overrides.debit ?? 100 },
      ],
    };
  }

  it("writes every valid transaction directly to the DB", async () => {
    const progress = createProgress();
    const ticks: { chunkId: string; kind: "tx" | "question" }[] = [];
    progress.subscribe(e => { ticks.push(e); });
    const res = await accountIngestTools.execute(db, "record_transactions", {
      transactions: [
        buildTx({ description: "Coffee 1" }),
        buildTx({ description: "Coffee 2", debit: 120 }),
        buildTx({ description: "Coffee 3", debit: 150 }),
      ],
    }, ctx({ scanId: "sc:test", chunkId: "f.pdf#p1", progress }));

    expect(res).toMatch(/Posted 3 of 3/);
    const rows = db.prepare(`SELECT description FROM transactions ORDER BY rowid`).all() as { description: string }[];
    expect(rows.map(r => r.description)).toEqual(["Coffee 1", "Coffee 2", "Coffee 3"]);
    expect(ticks.filter(t => t.kind === "tx")).toHaveLength(3);
  });

  it("rejects a batch over 50 without writing anything", async () => {
    const transactions = Array.from({ length: 51 }, (_, i) => buildTx({ description: `Row ${i}` }));
    const res = await accountIngestTools.execute(db, "record_transactions", { transactions }, ctx({ scanId: "sc:test" }));

    expect(res).toMatch(/at most 50/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()).toMatchObject({ n: 0 });
  });

  it("reports per-item validation errors and still writes the valid rows", async () => {
    const res = await accountIngestTools.execute(db, "record_transactions", {
      transactions: [
        buildTx({ description: "Valid 1" }),
        // Invalid: posting with both debit and credit.
        {
          date: "2026-05-19",
          description: "Invalid both",
          postings: [
            { account_id: "expense:food", debit: 50, credit: 50 },
            { account_id: "asset:kbank", credit: 50 },
          ],
        },
        buildTx({ description: "Valid 2", debit: 200 }),
      ],
    }, ctx({ scanId: "sc:test" }));

    expect(res).toMatch(/Posted 2 of 3/);
    expect(res).toMatch(/index 1/);
    const rows = db.prepare(`SELECT description FROM transactions ORDER BY rowid`).all() as { description: string }[];
    expect(rows.map(r => r.description)).toEqual(["Valid 1", "Valid 2"]);
  });

  it("records a scan_commit_failure question when an insert fails under a scanId", async () => {
    // Force a failure: post to a non-existent account.
    const res = await accountIngestTools.execute(db, "record_transactions", {
      transactions: [
        {
          date: "2026-05-19",
          description: "Bad",
          postings: [
            { account_id: "expense:does-not-exist", debit: 50 },
            { account_id: "asset:kbank", credit: 50 },
          ],
        },
      ],
    }, ctx({ scanId: "sc:test" }));

    expect(res).toMatch(/Posted 0 of 1/);
    const questions = listQuestions(db, { scanId: "sc:test" });
    expect(questions).toHaveLength(1);
    expect(questions[0].kind).toBe("scan_commit_failure");
  });

  it("rejects an empty transactions array", async () => {
    const res = await accountIngestTools.execute(db, "record_transactions", {
      transactions: [],
    }, ctx({ scanId: "sc:test" }));
    expect(res).toMatch(/at least one transaction/);
  });
});

describe("scanQuestionTools — note_question", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("writes directly to the questions table under the scanId", async () => {
    const progress = createProgress();
    const ticks: { chunkId: string; kind: "tx" | "question" }[] = [];
    progress.subscribe(e => { ticks.push(e); });
    const res = await scanQuestionTools.execute(db, "note_question", {
      prompt: "Is this Spotify?",
      kind: "uncategorized_expense",
    }, ctx({ scanId: "sc:test", chunkId: "f.pdf#p1", progress }));

    expect(res).toMatch(/Question noted/);
    const questions = listQuestions(db, { scanId: "sc:test" });
    expect(questions).toHaveLength(1);
    expect(questions[0].kind).toBe("uncategorized_expense");
    expect(ticks.filter(t => t.kind === "question")).toHaveLength(1);
  });
});
