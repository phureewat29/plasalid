import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import {
  createAccount,
  findAccountById,
  getAccountBalancesFromTransfers,
  getNetWorthFromTransfers,
  getPeriodTotalsFromTransfers,
  getRollupBalanceFromTransfers,
  repointTransfers,
  adjustAccountBalanceViaTransfer,
} from "./account-balance.js";
import { insertTransfer, getTransfer, type TransferInput } from "./transfers.js";

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

function ins(db: Database.Database, over: Partial<TransferInput> & Pick<TransferInput, "debit_account_id" | "credit_account_id" | "amount">) {
  insertTransfer(db, {
    date: "2026-05-01",
    description: "x",
    currency: "THB",
    ...over,
  });
}

describe("getAccountBalancesFromTransfers", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("derives minor-unit + decimal balances per the normal-balance rule", () => {
    // 150.00 THB expense funded from cash.
    ins(db, { debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 15000 });
    const balances = getAccountBalancesFromTransfers(db);

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
    const expenses = getAccountBalancesFromTransfers(db, { type: "expense" });
    expect(expenses.every((b) => b.type === "expense")).toBe(true);
    expect(expenses.some((b) => b.id === "asset:cash")).toBe(false);
  });
});

describe("getNetWorthFromTransfers", () => {
  it("sums assets minus liabilities", () => {
    const db = freshDb();
    // Salary lands in the bank: +1000 THB asset.
    ins(db, { debit_account_id: "asset:bank", credit_account_id: "income:salary", amount: 100000 });
    const nw = getNetWorthFromTransfers(db);
    expect(nw.assets).toBe(1000);
    expect(nw.liabilities).toBe(0);
    expect(nw.net_worth).toBe(1000);
  });
});

describe("getPeriodTotalsFromTransfers", () => {
  it("computes income (C-D) and expenses (D-C) over the range", () => {
    const db = freshDb();
    ins(db, { debit_account_id: "asset:cash", credit_account_id: "income:salary", amount: 100000, date: "2026-05-10" });
    ins(db, { debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 15000, date: "2026-05-11" });
    // Out-of-range transfer must not count.
    ins(db, { debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 99900, date: "2026-07-01" });

    const totals = getPeriodTotalsFromTransfers(db, "2026-05-01", "2026-05-31");
    expect(totals.income).toBe(1000);
    expect(totals.expenses).toBe(150);
  });
});

describe("getRollupBalanceFromTransfers", () => {
  it("sums a subtree (root inclusive)", () => {
    const db = freshDb();
    ins(db, { debit_account_id: "expense:food:dining", credit_account_id: "asset:cash", amount: 35000 });
    ins(db, { debit_account_id: "expense:food:groceries", credit_account_id: "asset:cash", amount: 60000 });
    expect(getRollupBalanceFromTransfers(db, "expense:food")).toBe(950);
    expect(getRollupBalanceFromTransfers(db, "asset:cash")).toBe(-950);
  });
});

describe("repointTransfers", () => {
  it("moves both columns and deletes would-be self-transfers", () => {
    const db = freshDb();
    ins(db, { id: "tf:1", debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 10000 });
    ins(db, { id: "tf:2", debit_account_id: "asset:cash", credit_account_id: "expense:food", amount: 10000 });
    // Re-pointing food -> dining would collapse this row (dining on both sides).
    ins(db, { id: "tf:self", debit_account_id: "expense:food", credit_account_id: "expense:food:dining", amount: 10000 });

    const res = repointTransfers(db, "expense:food", "expense:food:dining");
    expect(res.deletedSelfTransfers).toBe(1);
    expect(res.moved).toBe(2);
    expect(getTransfer(db, "tf:1")?.debit_account_id).toBe("expense:food:dining");
    expect(getTransfer(db, "tf:2")?.credit_account_id).toBe("expense:food:dining");
    expect(getTransfer(db, "tf:self")).toBeNull();
  });

  it("refuses re-pointing an account to itself", () => {
    const db = freshDb();
    expect(() => repointTransfers(db, "expense:food", "expense:food")).toThrow();
  });
});

describe("adjustAccountBalanceViaTransfer", () => {
  it("posts a balancing transfer against equity:adjustments", () => {
    const db = freshDb();
    const res = adjustAccountBalanceViaTransfer(db, {
      accountId: "asset:cash",
      targetAmount: 1500,
      reason: "set to market value",
    });
    expect(res.delta).toBe(1500);
    expect(res.transferId).not.toBeNull();
    expect(findAccountById(db, "equity:adjustments")).toBeTruthy();

    const cash = getAccountBalancesFromTransfers(db).find((b) => b.id === "asset:cash")!;
    expect(cash.balance).toBe(1500);
  });

  it("is a no-op when already at target", () => {
    const db = freshDb();
    ins(db, { debit_account_id: "asset:cash", credit_account_id: "income:salary", amount: 150000 });
    // asset:cash is now +1500.
    const res = adjustAccountBalanceViaTransfer(db, {
      accountId: "asset:cash",
      targetAmount: 1500,
      reason: "already there",
    });
    expect(res).toEqual({ transferId: null, delta: 0 });
  });

  it("throws for an unknown account", () => {
    const db = freshDb();
    expect(() =>
      adjustAccountBalanceViaTransfer(db, { accountId: "asset:nope", targetAmount: 10, reason: "x" }),
    ).toThrow(/not found/);
  });
});
