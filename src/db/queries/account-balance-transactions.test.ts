import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import {
  createAccount,
  findAccountById,
  getAccountBalancesFromTransactions,
  getNetWorthFromTransactions,
  getPeriodTotalsFromTransactions,
  getRollupBalanceFromTransactions,
  repointTransactions,
  adjustAccountBalanceViaTransaction,
} from "./account-balance.js";
import { insertTransaction, getTransaction, type TransactionInput } from "./transactions.js";

function freshDb(): Database.Database {
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

describe("getAccountBalancesFromTransactions", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("derives minor-unit + decimal balances per the normal-balance rule", () => {
    // 150.00 THB expense funded from cash.
    ins(db, { debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 15000 });
    const balances = getAccountBalancesFromTransactions(db);

    const food = balances.find((b) => b.id === "expense:food")!;
    expect(food.debits_posted).toBe(15000);
    expect(food.credits_posted).toBe(0);
    expect(food.balance_minor).toBe(15000); // debit-normal
    expect(food.balance).toBe(150);

    const cash = balances.find((b) => b.id === "asset:cash")!;
    expect(cash.balance_minor).toBe(-15000); // asset debit-normal, only credited here
    expect(cash.balance).toBe(-150);
  });

  it("filters by type", () => {
    ins(db, { debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 15000 });
    const expenses = getAccountBalancesFromTransactions(db, { type: "expense" });
    expect(expenses.every((b) => b.type === "expense")).toBe(true);
    expect(expenses.some((b) => b.id === "asset:cash")).toBe(false);
  });
});

describe("getNetWorthFromTransactions", () => {
  it("sums assets minus liabilities", () => {
    const db = freshDb();
    // Salary lands in the bank: +1000 THB asset.
    ins(db, { debit_account_id: "asset:bank", credit_account_id: "income:salary", amount: 100000 });
    const nw = getNetWorthFromTransactions(db);
    expect(nw.assets).toBe(1000);
    expect(nw.liabilities).toBe(0);
    expect(nw.net_worth).toBe(1000);
  });
});

describe("getPeriodTotalsFromTransactions", () => {
  it("computes income (C-D) and expenses (D-C) over the range", () => {
    const db = freshDb();
    ins(db, { debit_account_id: "asset:cash", credit_account_id: "income:salary", amount: 100000, date: "2026-05-10" });
    ins(db, { debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 15000, date: "2026-05-11" });
    // Out-of-range transaction must not count.
    ins(db, { debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 99900, date: "2026-07-01" });

    const totals = getPeriodTotalsFromTransactions(db, "2026-05-01", "2026-05-31");
    expect(totals.income).toBe(1000);
    expect(totals.expenses).toBe(150);
  });
});

describe("getRollupBalanceFromTransactions", () => {
  it("sums a subtree (root inclusive)", () => {
    const db = freshDb();
    ins(db, { debit_account_id: "expense:food:dining", credit_account_id: "asset:cash", amount: 35000 });
    ins(db, { debit_account_id: "expense:food:groceries", credit_account_id: "asset:cash", amount: 60000 });
    expect(getRollupBalanceFromTransactions(db, "expense:food")).toBe(950);
    expect(getRollupBalanceFromTransactions(db, "asset:cash")).toBe(-950);
  });
});

describe("repointTransactions", () => {
  it("moves both columns and deletes would-be self-transactions", () => {
    const db = freshDb();
    ins(db, { id: "tx:1", debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 10000 });
    ins(db, { id: "tx:2", debit_account_id: "asset:cash", credit_account_id: "expense:food", amount: 10000 });
    // Re-pointing food -> dining would collapse this row (dining on both sides).
    ins(db, { id: "tx:self", debit_account_id: "expense:food", credit_account_id: "expense:food:dining", amount: 10000 });

    const res = repointTransactions(db, "expense:food", "expense:food:dining");
    expect(res.deletedSelfTransactions).toBe(1);
    expect(res.moved).toBe(2);
    expect(getTransaction(db, "tx:1")?.debit_account_id).toBe("expense:food:dining");
    expect(getTransaction(db, "tx:2")?.credit_account_id).toBe("expense:food:dining");
    expect(getTransaction(db, "tx:self")).toBeNull();
  });

  it("refuses re-pointing an account to itself", () => {
    const db = freshDb();
    expect(() => repointTransactions(db, "expense:food", "expense:food")).toThrow();
  });
});

describe("adjustAccountBalanceViaTransaction", () => {
  it("posts a balancing transaction against equity:adjustments", () => {
    const db = freshDb();
    const res = adjustAccountBalanceViaTransaction(db, {
      accountId: "asset:cash",
      targetAmount: 1500,
      reason: "set to market value",
    });
    expect(res.delta).toBe(1500);
    expect(res.transactionId).not.toBeNull();
    expect(findAccountById(db, "equity:adjustments")).toBeTruthy();

    const cash = getAccountBalancesFromTransactions(db).find((b) => b.id === "asset:cash")!;
    expect(cash.balance).toBe(1500);
  });

  it("is a no-op when already at target", () => {
    const db = freshDb();
    ins(db, { debit_account_id: "asset:cash", credit_account_id: "income:salary", amount: 150000 });
    // asset:cash is now +1500.
    const res = adjustAccountBalanceViaTransaction(db, {
      accountId: "asset:cash",
      targetAmount: 1500,
      reason: "already there",
    });
    expect(res).toEqual({ transactionId: null, delta: 0 });
  });

  it("throws for an unknown account", () => {
    const db = freshDb();
    expect(() =>
      adjustAccountBalanceViaTransaction(db, { accountId: "asset:nope", targetAmount: 10, reason: "x" }),
    ).toThrow(/not found/);
  });
});
