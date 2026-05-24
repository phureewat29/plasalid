import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { createAccount } from "../db/queries/account-balance.js";
import { upsertMerchant } from "../db/queries/merchants.js";
import { recordTransaction } from "../db/queries/transactions.js";
import { recordQuestion, listQuestions } from "../db/queries/questions.js";
import { listRules, upsertRule } from "../db/queries/rules.js";
import { CLARIFIER_PASSES, runClarify } from "./clarifier.js";
import { synthesizeMemoryRules } from "./clarifier-memory.js";
import type { ClarifierPass } from "./clarifier.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:uncategorized", name: "Uncategorized", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "expense:shopping", name: "Shopping", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "asset:kbank", name: "KBank", type: "asset", parent_id: "asset" });
  return db;
}

function pass(name: string): ClarifierPass {
  const found = CLARIFIER_PASSES.find(p => p.name === name);
  if (!found) throw new Error(`No pass named ${name}`);
  return found;
}

describe("memoryRulePass", () => {
  it("closes a matching question via (kind, key) lookup", async () => {
    const db = freshDb();
    const id = recordQuestion(db, {
      file_id: null,
      transaction_id: null,
      account_id: null,
      kind: "uncategorized_expense",
      prompt: "Categorize Lazada charge dated 2026-04-01",
      context: { rule_key: "descriptor:lazada thailand" },
    });
    upsertRule(db, { kind: "uncategorized_expense", key: "descriptor:lazada thailand", target: "expense:shopping" });

    const summary = await runClarify({ db, interactive: false });

    expect(summary.clarified).toBe(1);
    expect(summary.remaining).toBe(0);
    expect(summary.tally.memory_rule).toBe(1);
    expect(listQuestions(db).find(u => u.id === id)).toBeUndefined();
  });

  it("leaves a question open when no rule matches its (kind, key)", async () => {
    const db = freshDb();
    recordQuestion(db, {
      file_id: null,
      transaction_id: null,
      account_id: null,
      kind: "uncategorized_expense",
      prompt: "Categorize unseen merchant",
      context: { rule_key: "descriptor:unseen" },
    });
    const summary = await runClarify({ db, interactive: false });
    expect(summary.clarified).toBe(0);
    expect(summary.remaining).toBe(1);
  });

  it("leaves questions without a rule_key open (no prose matching)", async () => {
    const db = freshDb();
    recordQuestion(db, {
      file_id: null,
      transaction_id: null,
      account_id: null,
      kind: "uncategorized_expense",
      prompt: "Categorize Lazada charge",
    });
    upsertRule(db, { kind: "uncategorized_expense", key: "descriptor:lazada", target: "expense:shopping" });
    const summary = await runClarify({ db, interactive: false });
    expect(summary.clarified).toBe(0);
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
    const summary = await runClarify({ db, interactive: false });
    expect(summary.clarified).toBe(1);
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
    const summary = await runClarify({ db, interactive: false });
    expect(summary.clarified).toBe(0);
    expect(summary.remaining).toBe(1);
  });
});

describe("synthesizeMemoryRules", () => {
  it("upserts one rule per (kind, rule_key) closure", () => {
    const db = freshDb();
    const closures = [
      { prompt: "Categorize Lazada", kind: "uncategorized_expense", answer: "expense:shopping", rule_key: "descriptor:lazada" },
      { prompt: "Categorize 7-Eleven", kind: "uncategorized_expense", answer: "expense:food", rule_key: "descriptor:7 eleven" },
    ];
    const upserted = synthesizeMemoryRules(db, closures);
    expect(upserted).toBe(2);
    expect(listRules(db)).toHaveLength(2);
  });

  it("upserts (overwrites target, bumps evidence_count) on repeated closures", () => {
    const db = freshDb();
    synthesizeMemoryRules(db, [
      { prompt: "Lazada", kind: "uncategorized_expense", answer: "expense:shopping", rule_key: "descriptor:lazada" },
    ]);
    synthesizeMemoryRules(db, [
      { prompt: "Lazada", kind: "uncategorized_expense", answer: "expense:shopping", rule_key: "descriptor:lazada" },
    ]);
    const rules = listRules(db);
    expect(rules).toHaveLength(1);
    expect(rules[0].evidence_count).toBe(2);
  });

  it("drops Skip closures (no rule learned)", () => {
    const db = freshDb();
    synthesizeMemoryRules(db, [
      { prompt: "Something", kind: "uncategorized_expense", answer: "Skip — leave as is", rule_key: "descriptor:something" },
    ]);
    expect(listRules(db)).toHaveLength(0);
  });

  it("drops closures with no rule_key (no structural signature, nothing to learn from)", () => {
    const db = freshDb();
    synthesizeMemoryRules(db, [
      { prompt: "Free-form question", kind: "uncategorized_expense", answer: "expense:food", rule_key: null },
    ]);
    expect(listRules(db)).toHaveLength(0);
  });

  it("drops failure-class kinds (dirty_input, scan_truncated)", () => {
    const db = freshDb();
    synthesizeMemoryRules(db, [
      { prompt: "Bad row", kind: "dirty_input", answer: "expense:food", rule_key: "descriptor:bad" },
      { prompt: "Truncated", kind: "scan_truncated", answer: "expense:food", rule_key: "descriptor:trunc" },
    ]);
    expect(listRules(db)).toHaveLength(0);
  });
});

describe("runClarify outer loop", () => {
  it("returns an empty summary when there are no questions", async () => {
    const db = freshDb();
    const summary = await runClarify({ db, interactive: false });
    expect(summary).toEqual({ total: 0, clarified: 0, remaining: 0, tally: {} });
  });

  it("re-fetches questions live across passes (deterministic only)", async () => {
    const db = freshDb();
    upsertRule(db, { kind: "uncategorized_expense", key: "descriptor:first", target: "expense:food" });
    recordQuestion(db, {
      file_id: null,
      transaction_id: null,
      account_id: null,
      kind: "uncategorized_expense",
      prompt: "First",
      context: { rule_key: "descriptor:first" },
    });
    recordQuestion(db, {
      file_id: null,
      transaction_id: null,
      account_id: null,
      kind: "boundary_continuation",
      prompt: "Second",
    });
    const summary = await runClarify({ db, interactive: false });
    expect(summary.total).toBe(2);
    expect(summary.clarified).toBe(1);
    expect(summary.remaining).toBe(1);
  });

  it("scopes by scanId", async () => {
    const db = freshDb();
    upsertRule(db, { kind: "uncategorized_expense", key: "descriptor:scoped", target: "expense:food" });
    recordQuestion(db, {
      file_id: null,
      scan_id: "sc:a",
      transaction_id: null,
      account_id: null,
      kind: "uncategorized_expense",
      prompt: "Scoped",
      context: { rule_key: "descriptor:scoped" },
    });
    recordQuestion(db, {
      file_id: null,
      scan_id: "sc:b",
      transaction_id: null,
      account_id: null,
      kind: "uncategorized_expense",
      prompt: "Other",
      context: { rule_key: "descriptor:other" },
    });
    const summary = await runClarify({ db, scanId: "sc:a", interactive: false });
    expect(summary.total).toBe(1);
    expect(summary.clarified).toBe(1);
    expect(summary.remaining).toBe(0);
    expect(listQuestions(db, { scanId: "sc:b" })).toHaveLength(1);
  });

  it("compacts closures into the rules table", async () => {
    const db = freshDb();
    upsertRule(db, { kind: "uncategorized_expense", key: "descriptor:first", target: "expense:food" });
    recordQuestion(db, {
      file_id: null,
      transaction_id: null,
      account_id: null,
      kind: "uncategorized_expense",
      prompt: "First",
      context: { rule_key: "descriptor:first" },
    });
    await runClarify({ db, interactive: false });
    const rules = listRules(db);
    // The seed rule plus the synthesized closure: same (kind, key) so the
    // upsert collapses them — exactly one row, evidence_count bumped to 2.
    expect(rules).toHaveLength(1);
    expect(rules[0].evidence_count).toBe(2);
  });
});

void pass; // re-exported for downstream test consumers
