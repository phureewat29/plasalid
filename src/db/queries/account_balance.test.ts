import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import {
  createAccount,
  updateAccountMetadata,
  findAccountById,
  findAccountsByFuzzyName,
  getAccountSubtree,
  getRollupBalance,
  ensureStructuralAccount,
  ensureTopLevelRoot,
} from "./account_balance.js";
import { recordTransaction } from "./transactions.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

describe("createAccount", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("inserts a top-level type root with parent_id=null", () => {
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    const row = findAccountById(db, "asset");
    expect(row).toBeTruthy();
    expect(row!.parent_id).toBeNull();
  });

  it("inserts a leaf account under an existing parent", () => {
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, {
      id: "asset:kbank-savings-1234",
      name: "KBank Savings ••1234",
      type: "asset",
      parent_id: "asset",
      subtype: "bank",
      bank_name: "kbank",
      account_number_masked: "••1234",
      currency: "THB",
    });
    const row = findAccountById(db, "asset:kbank-savings-1234");
    expect(row).toBeTruthy();
    expect(row!.parent_id).toBe("asset");
    expect(row!.bank_name).toBe("KBANK");
    expect(row!.currency).toBe("THB");
  });

  it("auto-bootstraps the top-level root when the parent is one of the five types", () => {
    createAccount(db, {
      id: "expense:food",
      name: "Food",
      type: "expense",
      parent_id: "expense",
    });
    expect(findAccountById(db, "expense")).toBeTruthy();
    expect(findAccountById(db, "expense:food")).toBeTruthy();
  });

  it("rejects parent/type mismatch", () => {
    createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
    expect(() =>
      createAccount(db, { id: "expense:misc", name: "Misc", type: "asset", parent_id: "expense" }),
    ).toThrow(/does not match parent/);
  });

  it("rejects id without parent prefix", () => {
    createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
    expect(() =>
      createAccount(db, { id: "groceries", name: "Groceries", type: "expense", parent_id: "expense" }),
    ).toThrow(/must start with parent id/);
  });

  it("rejects missing parent when not auto-bootstrappable", () => {
    expect(() =>
      createAccount(db, { id: "expense:food:nuts", name: "Nuts", type: "expense", parent_id: "expense:food" }),
    ).toThrow(/does not exist/);
  });

  it("throws ACCOUNT_EXISTS on duplicate id", () => {
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, { id: "asset:dup", name: "First", type: "asset", parent_id: "asset" });
    expect(() =>
      createAccount(db, { id: "asset:dup", name: "Second", type: "asset", parent_id: "asset" }),
    ).toThrow(/already exists/);
  });

  it("serializes metadata to JSON", () => {
    createAccount(db, {
      id: "liability:ktc",
      name: "KTC Card",
      type: "liability",
      parent_id: "liability",
      metadata: { points_program: "Forever" },
    });
    const row = findAccountById(db, "liability:ktc")!;
    expect(JSON.parse(row.metadata_json!)).toEqual({ points_program: "Forever" });
  });
});

describe("ensureStructuralAccount + ensureTopLevelRoot", () => {
  it("idempotently creates uncategorized expense + parent", () => {
    const db = freshDb();
    ensureStructuralAccount(db, "expense:uncategorized");
    ensureStructuralAccount(db, "expense:uncategorized");
    expect(findAccountById(db, "expense")).toBeTruthy();
    const row = findAccountById(db, "expense:uncategorized")!;
    expect(row.parent_id).toBe("expense");
    expect(row.name).toBe("Uncategorized");
  });

  it("idempotently creates the five top-level type roots", () => {
    const db = freshDb();
    for (const t of ["asset", "liability", "income", "expense", "equity"] as const) {
      ensureTopLevelRoot(db, t);
      ensureTopLevelRoot(db, t);
      expect(findAccountById(db, t)).toBeTruthy();
    }
  });
});

describe("hierarchy: getAccountSubtree + getRollupBalance", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
    createAccount(db, { id: "expense:food:groceries", name: "Groceries", type: "expense", parent_id: "expense:food" });
    createAccount(db, { id: "expense:food:dining", name: "Dining", type: "expense", parent_id: "expense:food" });
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, { id: "asset:cash", name: "Cash", type: "asset", parent_id: "asset" });
  });

  it("returns the subtree rooted at a given id", () => {
    const subtree = getAccountSubtree(db, "expense:food");
    const ids = subtree.map(r => r.id).sort();
    expect(ids).toEqual([
      "expense:food",
      "expense:food:dining",
      "expense:food:groceries",
    ]);
  });

  it("sums balances across the subtree", () => {
    recordTransaction(db, {
      date: "2026-02-01",
      description: "Lunch",
      postings: [
        { account_id: "expense:food:dining", debit: 350 },
        { account_id: "asset:cash", credit: 350 },
      ],
    });
    recordTransaction(db, {
      date: "2026-02-02",
      description: "Groceries",
      postings: [
        { account_id: "expense:food:groceries", debit: 600 },
        { account_id: "asset:cash", credit: 600 },
      ],
    });
    expect(getRollupBalance(db, "expense:food")).toBe(950);
    expect(getRollupBalance(db, "asset:cash")).toBe(-950);
  });
});

describe("updateAccountMetadata", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    createAccount(db, {
      id: "liability:ktc",
      name: "KTC Card",
      type: "liability",
      parent_id: "liability",
      bank_name: "ktc",
      due_day: 15,
    });
  });

  it("returns before/after for changed fields", () => {
    const result = updateAccountMetadata(db, "liability:ktc", { due_day: 20, statement_day: 28 });
    expect(result.changed).toBe(true);
    expect(result.before.due_day).toBe(15);
    expect(result.after.due_day).toBe(20);
    expect(result.before.statement_day).toBeNull();
    expect(result.after.statement_day).toBe(28);
  });

  it("reports no change when patch is empty", () => {
    const result = updateAccountMetadata(db, "liability:ktc", {});
    expect(result.changed).toBe(false);
  });

  it("shallow-merges metadata into the existing blob", () => {
    updateAccountMetadata(db, "liability:ktc", { metadata: { points_program: "Forever" } });
    updateAccountMetadata(db, "liability:ktc", { metadata: { points_balance: 1200 } });
    const row = findAccountById(db, "liability:ktc")!;
    expect(JSON.parse(row.metadata_json!)).toEqual({
      points_program: "Forever",
      points_balance: 1200,
    });
  });

  it("throws on unknown account", () => {
    expect(() => updateAccountMetadata(db, "asset:nope", { due_day: 1 })).toThrow(/not found/);
  });
});

describe("findAccountsByFuzzyName", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    createAccount(db, { id: "asset:ttb-1", name: "TTB Savings ••1234", type: "asset", parent_id: "asset" });
    createAccount(db, { id: "asset:scb-1", name: "SCB Savings ••5678", type: "asset", parent_id: "asset" });
    createAccount(db, { id: "asset:kbank-1", name: "KBank Savings ••9012", type: "asset", parent_id: "asset" });
  });

  it("finds the right account by substring", () => {
    const matches = findAccountsByFuzzyName(db, "ttb saving");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].account.id).toBe("asset:ttb-1");
    expect(matches[0].similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("returns multiple candidates ranked by similarity", () => {
    const matches = findAccountsByFuzzyName(db, "saving");
    const ids = matches.map(m => m.account.id);
    expect(ids).toContain("asset:ttb-1");
    expect(ids).toContain("asset:scb-1");
    expect(ids).toContain("asset:kbank-1");
  });

  it("respects the threshold", () => {
    const matches = findAccountsByFuzzyName(db, "xyz", 0.9);
    expect(matches).toHaveLength(0);
  });

  it("returns nothing for empty query", () => {
    expect(findAccountsByFuzzyName(db, "")).toEqual([]);
    expect(findAccountsByFuzzyName(db, "   ")).toEqual([]);
  });
});
