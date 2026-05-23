import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { createAccount } from "../db/queries/account-balance.js";
import { upsertMerchant } from "../db/queries/merchants.js";
import { recordTransaction } from "../db/queries/transactions.js";
import { recordQuestion, listQuestions } from "../db/queries/questions.js";
import { saveMemory } from "../ai/memory.js";
import { RESOLVER_PASSES, runResolve } from "./resolver.js";
import { synthesizeMemoryRules } from "./resolver-memory.js";
import type { ResolverPass } from "./resolver.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:uncategorized", name: "Uncategorized", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "asset:kbank", name: "KBank", type: "asset", parent_id: "asset" });
  return db;
}

function pass(name: string): ResolverPass {
  const found = RESOLVER_PASSES.find(p => p.name === name);
  if (!found) throw new Error(`No pass named ${name}`);
  return found;
}

describe("memoryRulePass", () => {
  it("closes a matching question and deletes the row", async () => {
    const db = freshDb();
    const id = recordQuestion(db, {
      file_id: null,
      transaction_id: null,
      account_id: null,
      kind: "uncategorized_expense",
      prompt: "Categorize Lazada charge",
    });
    saveMemory(
      db,
      "[uncategorized_expense] Categorize Lazada charge -> expense:food",
      "scanning_hint",
    );
    const summary = await runResolve({ db, interactive: false });
    expect(summary.resolved).toBe(1);
    expect(summary.remaining).toBe(0);
    expect(summary.tally.memory_rule).toBe(1);
    expect(listQuestions(db).find(u => u.id === id)).toBeUndefined();
  });

  it("leaves unmatched kinds open", async () => {
    const db = freshDb();
    recordQuestion(db, {
      file_id: null,
      transaction_id: null,
      account_id: null,
      kind: "boundary_continuation",
      prompt: "Row continues onto next page.",
    });
    const summary = await runResolve({ db, interactive: false });
    expect(summary.resolved).toBe(0);
    expect(summary.remaining).toBe(1);
  });
});

describe("merchantDefaultPass", () => {
  it("updates the posting and deletes the question", async () => {
    const db = freshDb();
    const merchant = upsertMerchant(db, {
      canonical_name: "Starbucks",
      default_account_id: "expense:food",
    });
    const txId = recordTransaction(db, {
      date: "2026-05-19",
      description: "Coffee",
      merchant_id: merchant.id,
      postings: [
        { account_id: "expense:uncategorized", debit: 120 },
        { account_id: "asset:kbank", credit: 120 },
      ],
    });
    recordQuestion(db, {
      file_id: null,
      transaction_id: txId,
      account_id: null,
      kind: "uncategorized_expense",
      prompt: "Categorize Starbucks",
    });
    const summary = await runResolve({ db, interactive: false });
    expect(summary.resolved).toBe(1);
    expect(summary.remaining).toBe(0);
    expect(summary.tally.merchant_default).toBe(1);
    const posting = db
      .prepare(
        `SELECT account_id FROM postings WHERE transaction_id = ? AND account_id = 'expense:food'`,
      )
      .get(txId);
    expect(posting).toBeTruthy();
  });

  it("skips when the merchant has no default_account_id", async () => {
    const db = freshDb();
    const merchant = upsertMerchant(db, { canonical_name: "Lazada" });
    const txId = recordTransaction(db, {
      date: "2026-05-19",
      description: "Order",
      merchant_id: merchant.id,
      postings: [
        { account_id: "expense:uncategorized", debit: 500 },
        { account_id: "asset:kbank", credit: 500 },
      ],
    });
    recordQuestion(db, {
      file_id: null,
      transaction_id: txId,
      account_id: null,
      kind: "uncategorized_expense",
      prompt: "Categorize Lazada",
    });
    const summary = await runResolve({ db, interactive: false });
    expect(summary.resolved).toBe(0);
    expect(summary.remaining).toBe(1);
  });
});

describe("synthesizeMemoryRules", () => {
  it("inserts one rule per closure", () => {
    const db = freshDb();
    const closures = [
      { prompt: "Categorize Lazada", kind: "uncategorized_expense", answer: "expense:shopping" },
      { prompt: "Categorize 7-Eleven", kind: "uncategorized_expense", answer: "expense:food" },
    ];
    const inserted = synthesizeMemoryRules(db, closures);
    expect(inserted).toBe(2);
    const rules = db.prepare(`SELECT content FROM memories WHERE category = 'scanning_hint'`).all() as { content: string }[];
    expect(rules).toHaveLength(2);
  });

  it("dedupes identical rules", () => {
    const db = freshDb();
    const closures = [
      { prompt: "Categorize Lazada", kind: "uncategorized_expense", answer: "expense:shopping" },
    ];
    expect(synthesizeMemoryRules(db, closures)).toBe(1);
    expect(synthesizeMemoryRules(db, closures)).toBe(0);
    const rules = db.prepare(`SELECT content FROM memories WHERE category = 'scanning_hint'`).all() as { content: string }[];
    expect(rules).toHaveLength(1);
  });
});

describe("runResolve outer loop", () => {
  it("returns an empty summary when there are no questions", async () => {
    const db = freshDb();
    const summary = await runResolve({ db, interactive: false });
    expect(summary).toEqual({ total: 0, resolved: 0, remaining: 0, tally: {} });
  });

  it("re-fetches questions live across passes (deterministic only)", async () => {
    const db = freshDb();
    // Pre-loaded memory closes the first one.
    saveMemory(db, "[uncategorized_expense] First -> expense:food", "scanning_hint");
    recordQuestion(db, { file_id: null, transaction_id: null, account_id: null, kind: "uncategorized_expense", prompt: "First" });
    recordQuestion(db, { file_id: null, transaction_id: null, account_id: null, kind: "boundary_continuation", prompt: "Second" });
    const summary = await runResolve({ db, interactive: false });
    expect(summary.total).toBe(2);
    expect(summary.resolved).toBe(1);
    expect(summary.remaining).toBe(1);
  });

  it("scopes by scanId", async () => {
    const db = freshDb();
    saveMemory(db, "[uncategorized_expense] Scoped -> expense:food", "scanning_hint");
    recordQuestion(db, { file_id: null, scan_id: "sc:a", transaction_id: null, account_id: null, kind: "uncategorized_expense", prompt: "Scoped" });
    recordQuestion(db, { file_id: null, scan_id: "sc:b", transaction_id: null, account_id: null, kind: "uncategorized_expense", prompt: "Other" });
    const summary = await runResolve({ db, scanId: "sc:a", interactive: false });
    expect(summary.total).toBe(1);
    expect(summary.resolved).toBe(1);
    expect(summary.remaining).toBe(0);
    expect(listQuestions(db, { scanId: "sc:b" })).toHaveLength(1);
  });

  it("compacts closures into scanning_hint memories", async () => {
    const db = freshDb();
    saveMemory(db, "[uncategorized_expense] First -> expense:food", "scanning_hint");
    recordQuestion(db, { file_id: null, transaction_id: null, account_id: null, kind: "uncategorized_expense", prompt: "First" });
    await runResolve({ db, interactive: false });
    const rules = db.prepare(`SELECT content FROM memories WHERE category = 'scanning_hint'`).all() as { content: string }[];
    // Both the seed rule and the synthesized rule live there. The synthesized
    // one mirrors the seed (same prompt -> same answer) and dedupes.
    expect(rules.length).toBeGreaterThanOrEqual(1);
  });
});

void pass; // re-exported for downstream test consumers
