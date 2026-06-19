import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import {
  recordTransaction,
  listPostings,
  countTransactions,
  bulkUpdatePostings,
  getTransaction,
} from "./transactions.js";
import { upsertMerchant } from "./merchants.js";
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

  it("auto-balances an imbalanced transaction with an equity:adjustments posting", () => {
    const id = recordTransaction(db, {
      date: "2026-02-01",
      description: "Bank fee",
      postings: [
        { account_id: "expense:food", debit: 350 },
        { account_id: "asset:kbank", credit: 100 },
      ],
    });
    const postings = listPostings(db, { account_id: undefined });
    const onTx = postings.filter(p => p.transaction_id === id);
    expect(onTx).toHaveLength(3);
    const adjustment = onTx.find(p => p.account_id === "equity:adjustments");
    expect(adjustment).toBeDefined();
    expect(adjustment!.credit).toBe(250);
    expect(adjustment!.debit).toBe(0);
  });

  it("auto-balances a single-posting transaction", () => {
    const id = recordTransaction(db, {
      date: "2026-02-01",
      description: "Solo fee",
      postings: [{ account_id: "expense:food", debit: 100 }],
    });
    const postings = listPostings(db).filter(p => p.transaction_id === id);
    expect(postings).toHaveLength(2);
    const adjustment = postings.find(p => p.account_id === "equity:adjustments");
    expect(adjustment).toBeDefined();
    expect(adjustment!.credit).toBe(100);
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

  it("rejects empty-posting transactions", () => {
    expect(() =>
      recordTransaction(db, {
        date: "2026-02-01",
        description: "Bad",
        postings: [],
      }),
    ).toThrow(/at least one/);
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

describe("countTransactions", () => {
  it("returns zeros for an empty database", () => {
    const db = freshDb();
    const totals = countTransactions(db);
    expect(totals.transactions).toBe(0);
    expect(totals.postings).toBe(0);
  });

  it("returns transaction and posting counts", () => {
    const db = freshDb();
    recordTransaction(db, {
      date: "2026-02-01",
      description: "Lunch",
      postings: [
        { account_id: "expense:food", debit: 350 },
        { account_id: "asset:cash",   credit: 350 },
      ],
    });
    recordTransaction(db, {
      date: "2026-02-02",
      description: "Salary",
      postings: [
        { account_id: "asset:kbank",   debit: 60000 },
        { account_id: "income:salary", credit: 60000 },
      ],
    });
    const totals = countTransactions(db);
    expect(totals.transactions).toBe(2);
    expect(totals.postings).toBe(4);
  });
});

describe("bulkUpdatePostings", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`)
      .run("income:uncategorized", "Uncategorized Income", "income", "income");
  });

  function seedSalary(description: string, amount: number, date = "2026-02-01"): string {
    return recordTransaction(db, {
      date,
      description,
      postings: [
        { account_id: "asset:kbank", debit: amount },
        { account_id: "income:uncategorized", credit: amount },
      ],
    });
  }

  it("recategorizes only postings matching the filter", () => {
    seedSalary("บริษัท คริปโตมายด์ payroll", 50000);
    seedSalary("บริษัท คริปโตมาย payroll", 50000);  // truncated variant
    seedSalary("FAMILYMART", 120);                   // unrelated coffee run

    const result = bulkUpdatePostings(
      db,
      { account_id: "income:uncategorized", description_contains: "คริปโตมาย" },
      { account_id: "income:salary" },
    );

    expect(result.affected).toBe(2);
    expect(result.sample_posting_ids.length).toBe(2);
    expect(result.sample_posting_ids.every((id) => id.startsWith("p:"))).toBe(true);

    const remainingUncategorized = listPostings(db, { account_id: "income:uncategorized" });
    expect(remainingUncategorized).toHaveLength(1);
    expect(remainingUncategorized[0].transaction_description).toBe("FAMILYMART");

    const salaryPostings = listPostings(db, { account_id: "income:salary" });
    expect(salaryPostings).toHaveLength(2);
  });

  it("returns affected:0 and empty sample when nothing matches", () => {
    seedSalary("Some payroll", 10000);
    const result = bulkUpdatePostings(
      db,
      { description_contains: "nothing here" },
      { account_id: "income:salary" },
    );
    expect(result).toEqual({ affected: 0, sample_posting_ids: [] });
  });

  it("throws when no filter field is supplied", () => {
    expect(() => bulkUpdatePostings(db, {}, { account_id: "income:salary" })).toThrow(/filter/);
  });

  it("throws when no set field is supplied", () => {
    expect(() => bulkUpdatePostings(db, { account_id: "income:uncategorized" }, {})).toThrow(/set/);
  });

  it("throws on a no-op recategorization (set.account_id equals filter.account_id)", () => {
    expect(() =>
      bulkUpdatePostings(
        db,
        { account_id: "income:uncategorized" },
        { account_id: "income:uncategorized" },
      ),
    ).toThrow(/no-op/);
  });

  it("caps sample_posting_ids at 10 even when affected is larger", () => {
    for (let i = 0; i < 12; i++) seedSalary(`payroll ${i} from บริษัท คริปโตมายด์`, 100);
    const result = bulkUpdatePostings(
      db,
      { account_id: "income:uncategorized", description_contains: "คริปโต" },
      { account_id: "income:salary" },
    );
    expect(result.affected).toBe(12);
    expect(result.sample_posting_ids).toHaveLength(10);
  });

  it("filters by date range via from/to (counts every matching posting on every in-range tx)", () => {
    seedSalary("payroll คริปโต", 50000, "2025-12-01");
    seedSalary("payroll คริปโต", 50000, "2026-03-15");
    seedSalary("payroll คริปโต", 50000, "2026-06-01");

    const result = bulkUpdatePostings(
      db,
      { account_id: "income:uncategorized", description_contains: "คริปโต", from: "2026-01-01", to: "2026-04-30" },
      { account_id: "income:salary" },
    );
    // Only the 2026-03-15 row's income:uncategorized leg should flip; the kbank legs
    // are excluded by the account_id filter, and the out-of-range rows by date.
    expect(result.affected).toBe(1);
  });

  it("matches description_contains case-insensitively", () => {
    seedSalary("SPOTIFY THAILAND", 199);
    const result = bulkUpdatePostings(
      db,
      { account_id: "income:uncategorized", description_contains: "spotify" },
      { account_id: "income:salary" },
    );
    expect(result.affected).toBe(1);
  });

  it("filters by merchant_id", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Spotify" });
    recordTransaction(db, {
      date: "2026-02-01",
      description: "Spotify",
      merchant_id: merchant.id,
      postings: [
        { account_id: "income:uncategorized", credit: 199 },
        { account_id: "liability:ktc", debit: 199 },
      ],
    });
    seedSalary("payroll คริปโต", 199);  // same amount, no merchant

    const result = bulkUpdatePostings(
      db,
      { account_id: "income:uncategorized", merchant_id: merchant.id },
      { account_id: "income:salary" },
    );
    expect(result.affected).toBe(1);
  });
});

describe("getTransaction", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("returns the header, postings (with account names), and merchant canonical_name", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Spotify" });
    const id = recordTransaction(db, {
      date: "2026-02-01",
      description: "Spotify subscription",
      merchant_id: merchant.id,
      postings: [
        { account_id: "expense:food", debit: 199 },
        { account_id: "asset:kbank", credit: 199 },
      ],
    });

    const detail = getTransaction(db, id)!;
    expect(detail.id).toBe(id);
    expect(detail.date).toBe("2026-02-01");
    expect(detail.description).toBe("Spotify subscription");
    expect(detail.merchant_id).toBe(merchant.id);
    expect(detail.merchant_name).toBe("Spotify");
    expect(detail.postings).toHaveLength(2);

    const foodPosting = detail.postings.find(p => p.account_id === "expense:food")!;
    expect(foodPosting.account_name).toBe("Food");
    expect(foodPosting.debit).toBe(199);
    expect(foodPosting.credit).toBe(0);

    const kbankPosting = detail.postings.find(p => p.account_id === "asset:kbank")!;
    expect(kbankPosting.account_name).toBe("KBank Savings");
    expect(kbankPosting.credit).toBe(199);
  });

  it("returns a null merchant_name when the transaction has no merchant", () => {
    const id = recordTransaction(db, {
      date: "2026-02-01",
      description: "Cash withdrawal",
      postings: [
        { account_id: "expense:food", debit: 500 },
        { account_id: "asset:kbank", credit: 500 },
      ],
    });

    const detail = getTransaction(db, id)!;
    expect(detail.merchant_id).toBeNull();
    expect(detail.merchant_name).toBeNull();
  });

  it("returns null for a missing transaction id", () => {
    expect(getTransaction(db, "tx:nope")).toBeNull();
  });
});

