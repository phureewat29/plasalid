import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import {
  createAccount,
  updateAccountMetadata,
  findAccountById,
  getAccountSubtree,
  ensureStructuralAccount,
  ensureTopLevelRoot,
  repointTransactions,
} from "./accounts.js";
import { insertTransaction, findTransactionById, type TransactionInput } from "../db/queries/transactions.js";

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

  it("drops a trailing check digit from the stored masked number", () => {
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, {
      id: "asset:scb-savings-7652",
      name: "SCB Savings ••7652",
      type: "asset",
      parent_id: "asset",
      account_number_masked: "••7652-0",
      currency: "THB",
    });
    expect(findAccountById(db, "asset:scb-savings-7652")!.account_number_masked).toBe("••7652");
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

describe("hierarchy: getAccountSubtree", () => {
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
    expect(Object.keys(result.after).length).toBeGreaterThan(0);
    expect(result.before.due_day).toBe(15);
    expect(result.after.due_day).toBe(20);
    expect(result.before.statement_day).toBeNull();
    expect(result.after.statement_day).toBe(28);
  });

  it("reports no change when patch is empty", () => {
    const result = updateAccountMetadata(db, "liability:ktc", {});
    expect(Object.keys(result.after).length).toBe(0);
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

// repointTransactions is the re-point step of mergeAccounts (see accounts.ts).
function seededDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "asset:cash", name: "Cash", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "asset:bank", name: "KBank Savings", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "income", name: "Income", type: "income", parent_id: null });
  createAccount(db, { id: "income:salary", name: "Salary", type: "income", parent_id: "income" });
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "expense:food:dining", name: "Dining", type: "expense", parent_id: "expense:food" });
  createAccount(db, { id: "expense:food:groceries", name: "Groceries", type: "expense", parent_id: "expense:food" });
  return db;
}

function ins(db: Database.Database, over: Partial<TransactionInput> & Pick<TransactionInput, "debit_account_id" | "credit_account_id" | "amount">) {
  insertTransaction(db, {
    date: "2026-05-01",
    description: "x",
    currency: "THB",
    ...over,
  });
}

describe("repointTransactions", () => {
  it("moves both columns and deletes would-be self-transactions", () => {
    const db = seededDb();
    ins(db, { id: "tx:1", debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 10000 });
    ins(db, { id: "tx:2", debit_account_id: "asset:cash", credit_account_id: "expense:food", amount: 10000 });
    // Re-pointing food -> dining would collapse this row (dining on both sides).
    ins(db, { id: "tx:self", debit_account_id: "expense:food", credit_account_id: "expense:food:dining", amount: 10000 });

    const res = repointTransactions(db, "expense:food", "expense:food:dining");
    expect(res.deletedSelfTransactions).toBe(1);
    expect(res.moved).toBe(2);
    expect(findTransactionById(db, "tx:1")?.debit_account_id).toBe("expense:food:dining");
    expect(findTransactionById(db, "tx:2")?.credit_account_id).toBe("expense:food:dining");
    expect(findTransactionById(db, "tx:self")).toBeNull();
  });

  it("refuses re-pointing an account to itself", () => {
    const db = seededDb();
    expect(() => repointTransactions(db, "expense:food", "expense:food")).toThrow();
  });
});
