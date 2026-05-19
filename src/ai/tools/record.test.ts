import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../../db/schema.js";
import { recordTools } from "./record.js";
import {
  createAccount,
  getAccountBalances,
  findAccountById,
} from "../../db/queries/account_balance.js";
import { recordTransaction } from "../../db/queries/transactions.js";
import { listActions } from "../../db/queries/action_log.js";
import type { AgentExecutionContext } from "./types.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function ctx(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return {
    command: "record",
    correlationId: "cr:test",
    userInput: "test",
    interactive: false,
    ...overrides,
  };
}

describe("adjust_account_balance", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, { id: "liability", name: "Liabilities", type: "liability", parent_id: null });
    createAccount(db, { id: "asset:diem", name: "DIEM Investment", type: "asset", parent_id: "asset" });
    createAccount(db, { id: "liability:mortgage", name: "SCB Mortgage", type: "liability", parent_id: "liability" });
  });

  it("seeds an opening balance on an asset (debit account, credit equity)", async () => {
    const result = await recordTools.execute(db, "adjust_account_balance", {
      account_id: "asset:diem",
      target_balance: 500000,
      reason: "Set DIEM portfolio to current market value",
      date: "2026-05-19",
    }, ctx());

    expect(result).toMatch(/Adjusted/);
    const balances = getAccountBalances(db);
    expect(balances.find(b => b.id === "asset:diem")!.balance).toBe(500000);
    const equity = balances.find(b => b.id === "equity:adjustments");
    expect(equity).toBeTruthy();
    expect(equity!.balance).toBe(500000);
  });

  it("reduces an asset balance (credit account, debit equity)", async () => {
    recordTransaction(db, {
      date: "2026-01-01",
      description: "Seed",
      postings: [
        { account_id: "asset:diem", debit: 200000 },
        { account_id: "liability:mortgage", credit: 200000 },
      ],
    });
    await recordTools.execute(db, "adjust_account_balance", {
      account_id: "asset:diem",
      target_balance: 180000,
      reason: "Market depreciation",
    }, ctx({ correlationId: "cr:neg" }));

    const balances = getAccountBalances(db);
    expect(balances.find(b => b.id === "asset:diem")!.balance).toBe(180000);

    const actions = listActions(db, { correlationId: "cr:neg" });
    const adjust = actions.find(a => a.action_type === "adjust_balance")!;
    const payload = JSON.parse(adjust.payload_json);
    const assetPosting = payload.postings.find((p: any) => p.account_id === "asset:diem");
    const equityPosting = payload.postings.find((p: any) => p.account_id === "equity:adjustments");
    expect(assetPosting.credit).toBeGreaterThan(0);
    expect(assetPosting.debit ?? 0).toBe(0);
    expect(equityPosting.debit).toBeGreaterThan(0);
    expect(equityPosting.credit ?? 0).toBe(0);
  });

  it("uses the account's currency on a non-THB adjustment", async () => {
    createAccount(db, { id: "asset:diem-usd", name: "DIEM USD", type: "asset", parent_id: "asset", currency: "USD" });
    await recordTools.execute(db, "adjust_account_balance", {
      account_id: "asset:diem-usd",
      target_balance: 500,
      reason: "Seed USD",
    }, ctx({ correlationId: "cr:usd" }));

    const actions = listActions(db, { correlationId: "cr:usd" });
    const adjust = actions.find(a => a.action_type === "adjust_balance")!;
    const payload = JSON.parse(adjust.payload_json);
    for (const posting of payload.postings) {
      expect(posting.currency).toBe("USD");
    }
  });

  it("increases a liability balance (credit account, debit equity)", async () => {
    await recordTools.execute(db, "adjust_account_balance", {
      account_id: "liability:mortgage",
      target_balance: 1500000,
      reason: "Mortgage opening balance",
    }, ctx());
    const balances = getAccountBalances(db);
    expect(balances.find(b => b.id === "liability:mortgage")!.balance).toBe(1500000);
  });

  it("returns no-op when already at target", async () => {
    await recordTools.execute(db, "adjust_account_balance", {
      account_id: "asset:diem",
      target_balance: 100,
      reason: "Seed",
    }, ctx());
    const before = listActions(db).length;
    const result = await recordTools.execute(db, "adjust_account_balance", {
      account_id: "asset:diem",
      target_balance: 100,
      reason: "Same again",
    }, ctx());
    expect(result).toMatch(/already at/);
    expect(listActions(db).length).toBe(before);
  });

  it("writes an action_log row with action_type=adjust_balance", async () => {
    await recordTools.execute(db, "adjust_account_balance", {
      account_id: "asset:diem",
      target_balance: 500000,
      reason: "Seed",
    }, ctx({ correlationId: "cr:adj" }));
    const actions = listActions(db, { correlationId: "cr:adj" });
    const adjust = actions.find(a => a.action_type === "adjust_balance");
    expect(adjust).toBeTruthy();
    expect(adjust!.target_id).toMatch(/^tx:/);
    const payload = JSON.parse(adjust!.payload_json);
    expect(payload.account_id).toBe("asset:diem");
    expect(payload.before_balance).toBe(0);
    expect(payload.after_balance).toBe(500000);
  });

  it("auto-creates equity:adjustments only once across multiple adjustments", async () => {
    await recordTools.execute(db, "adjust_account_balance", {
      account_id: "asset:diem",
      target_balance: 100,
      reason: "First",
    }, ctx({ correlationId: "cr:1" }));
    await recordTools.execute(db, "adjust_account_balance", {
      account_id: "liability:mortgage",
      target_balance: 200,
      reason: "Second",
    }, ctx({ correlationId: "cr:2" }));

    expect(findAccountById(db, "equity:adjustments")).toBeTruthy();
    const creates = listActions(db).filter(a => a.action_type === "create_account" && a.target_id === "equity:adjustments");
    expect(creates).toHaveLength(1);
  });
});

describe("find_similar_accounts", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, { id: "asset:ttb-1", name: "TTB Savings ••1234", type: "asset", parent_id: "asset" });
    createAccount(db, { id: "asset:scb-1", name: "SCB Savings ••5678", type: "asset", parent_id: "asset" });
  });

  it("surfaces the right candidate for a phrase", async () => {
    const result = await recordTools.execute(db, "find_similar_accounts", {
      query: "ttb saving",
    }, ctx());
    expect(result).toMatch(/asset:ttb-1/);
    expect(result).toMatch(/TTB Savings/);
  });

  it("returns a no-match message when threshold isn't met", async () => {
    const result = await recordTools.execute(db, "find_similar_accounts", {
      query: "completely unrelated string",
      threshold: 0.9,
    }, ctx());
    expect(result).toMatch(/No accounts matched/);
  });
});

describe("clarify", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("returns a non-interactive marker when no promptUser is provided", async () => {
    const result = await recordTools.execute(db, "clarify", {
      prompt: "which account?",
      options: ["A", "B"],
    }, ctx({ interactive: false }));
    expect(result).toMatch(/non-interactive/);
  });

  it("returns the user's answer when interactive", async () => {
    const result = await recordTools.execute(db, "clarify", {
      prompt: "which account?",
    }, ctx({
      interactive: true,
      promptUser: async () => "A",
    }));
    expect(result).toMatch(/User answered: A/);
  });
});
