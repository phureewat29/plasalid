import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import { recordTransaction, listPostings } from "./transactions.js";
import { getAccountBalances, getNetWorth } from "./account-balance.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  // Top-level type roots
  db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`).run("asset", "Assets", "asset");
  db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`).run("liability", "Liabilities", "liability");
  db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`).run("income", "Income", "income");
  db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`).run("expense", "Expenses", "expense");
  db.prepare(`INSERT INTO accounts (id, name, type, parent_id, subtype, bank_name) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("asset:kbank", "KBank Savings", "asset", "asset", "bank", "KBANK");
  db.prepare(`INSERT INTO accounts (id, name, type, parent_id, subtype) VALUES (?, ?, ?, ?, ?)`)
    .run("asset:cash", "Cash", "asset", "asset", "cash");
  db.prepare(`INSERT INTO accounts (id, name, type, parent_id, subtype, bank_name) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("liability:ktc", "KTC Card", "liability", "liability", "credit_card", "KTC");
  db.prepare(`INSERT INTO accounts (id, name, type, parent_id, subtype) VALUES (?, ?, ?, ?, ?)`)
    .run("expense:food", "Food", "expense", "expense", "groceries");
  db.prepare(`INSERT INTO accounts (id, name, type, parent_id, subtype) VALUES (?, ?, ?, ?, ?)`)
    .run("income:salary", "Salary", "income", "income", "salary");
  return db;
}

describe("recordTransaction", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("inserts a balanced transaction", () => {
    const id = recordTransaction(db, {
      date: "2026-02-01",
      description: "Lunch",
      postings: [
        { account_id: "expense:food", debit: 350 },
        { account_id: "asset:kbank", credit: 350 },
      ],
    });
    expect(id).toMatch(/^tx:/);
    const postings = listPostings(db);
    expect(postings).toHaveLength(2);
  });

  it("rejects an unbalanced transaction", () => {
    expect(() =>
      recordTransaction(db, {
        date: "2026-02-01",
        description: "Bad",
        postings: [
          { account_id: "expense:food", debit: 350 },
          { account_id: "asset:kbank", credit: 100 },
        ],
      }),
    ).toThrow(/does not balance/);
  });

  it("rejects a posting with both debit and credit", () => {
    expect(() =>
      recordTransaction(db, {
        date: "2026-02-01",
        description: "Bad",
        postings: [
          { account_id: "expense:food", debit: 100, credit: 50 },
          { account_id: "asset:kbank", credit: 50 },
        ],
      }),
    ).toThrow(/cannot debit and credit/);
  });

  it("rejects single-posting transactions", () => {
    expect(() =>
      recordTransaction(db, {
        date: "2026-02-01",
        description: "Bad",
        postings: [{ account_id: "expense:food", debit: 100 }],
      }),
    ).toThrow(/at least two/);
  });

  it("computes balances from posted transactions", () => {
    recordTransaction(db, {
      date: "2026-01-25",
      description: "Salary",
      postings: [
        { account_id: "asset:kbank", debit: 50000 },
        { account_id: "income:salary", credit: 50000 },
      ],
    });
    recordTransaction(db, {
      date: "2026-02-01",
      description: "KTC purchase: groceries",
      postings: [
        { account_id: "expense:food", debit: 1200 },
        { account_id: "liability:ktc", credit: 1200 },
      ],
    });

    const balances = getAccountBalances(db);
    const byId = Object.fromEntries(balances.map(b => [b.id, b.balance]));
    expect(byId["asset:kbank"]).toBe(50000);
    expect(byId["income:salary"]).toBe(50000);
    expect(byId["expense:food"]).toBe(1200);
    expect(byId["liability:ktc"]).toBe(1200);

    const nw = getNetWorth(db);
    expect(nw.assets).toBe(50000);
    expect(nw.liabilities).toBe(1200);
    expect(nw.net_worth).toBe(48800);
  });

  it("cascades transactions and postings when a scanned_files row is deleted", () => {
    db.prepare(
      `INSERT INTO scanned_files (id, path, file_hash, mime, status)
       VALUES (?, ?, ?, ?, 'scanned')`,
    ).run("sf:1", "/tmp/x.pdf", "deadbeef", "application/pdf");

    recordTransaction(db, {
      date: "2026-02-01",
      description: "Tied to sf:1",
      source_file_id: "sf:1",
      postings: [
        { account_id: "expense:food", debit: 500 },
        { account_id: "asset:kbank", credit: 500 },
      ],
    });

    expect(listPostings(db)).toHaveLength(2);

    db.prepare(`DELETE FROM scanned_files WHERE id = ?`).run("sf:1");

    expect(listPostings(db)).toHaveLength(0);
    const txCount = db.prepare(`SELECT COUNT(*) as n FROM transactions`).get() as { n: number };
    expect(txCount.n).toBe(0);
  });

  it("upserts merchant inline when posting a transaction", () => {
    const id = recordTransaction(db, {
      date: "2026-02-01",
      description: "Coffee",
      raw_descriptor: "STARBUCKS #1234 BANGKOK",
      merchant: {
        canonical_name: "Starbucks",
        alias: "STARBUCKS #1234 BANGKOK",
        default_account_id: "expense:food",
      },
      postings: [
        { account_id: "expense:food", debit: 120 },
        { account_id: "liability:ktc", credit: 120 },
      ],
    });
    expect(id).toMatch(/^tx:/);

    const tx = db.prepare(`SELECT merchant_id, raw_descriptor FROM transactions WHERE id = ?`)
      .get(id) as { merchant_id: string; raw_descriptor: string };
    expect(tx.merchant_id).toMatch(/^m:/);
    expect(tx.raw_descriptor).toBe("STARBUCKS #1234 BANGKOK");

    const merchant = db.prepare(`SELECT canonical_name, default_account_id FROM merchants WHERE id = ?`)
      .get(tx.merchant_id) as { canonical_name: string; default_account_id: string };
    expect(merchant.canonical_name).toBe("Starbucks");
    expect(merchant.default_account_id).toBe("expense:food");
  });
});
