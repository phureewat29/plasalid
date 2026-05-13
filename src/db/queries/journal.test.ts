import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import { recordJournalEntry, listJournalLines } from "./journal.js";
import { getAccountBalances, getNetWorth } from "./account_balance.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare(`INSERT INTO accounts (id, name, type, subtype, bank_name) VALUES (?, ?, ?, ?, ?)`)
    .run("a:kbank", "KBank Savings", "asset", "bank", "KBANK");
  db.prepare(`INSERT INTO accounts (id, name, type, subtype) VALUES (?, ?, ?, ?)`)
    .run("a:cash", "Cash", "asset", "cash");
  db.prepare(`INSERT INTO accounts (id, name, type, subtype, bank_name) VALUES (?, ?, ?, ?, ?)`)
    .run("l:ktc", "KTC Card", "liability", "credit_card", "KTC");
  db.prepare(`INSERT INTO accounts (id, name, type, subtype) VALUES (?, ?, ?, ?)`)
    .run("e:food", "Food", "expense", "groceries");
  db.prepare(`INSERT INTO accounts (id, name, type, subtype) VALUES (?, ?, ?, ?)`)
    .run("i:salary", "Salary", "income", "salary");
  return db;
}

describe("recordJournalEntry", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("inserts a balanced entry", () => {
    const id = recordJournalEntry(db, {
      date: "2026-02-01",
      description: "Lunch",
      lines: [
        { account_id: "e:food", debit: 350 },
        { account_id: "a:kbank", credit: 350 },
      ],
    });
    expect(id).toMatch(/^je:/);
    const lines = listJournalLines(db);
    expect(lines).toHaveLength(2);
  });

  it("rejects an unbalanced entry", () => {
    expect(() =>
      recordJournalEntry(db, {
        date: "2026-02-01",
        description: "Bad",
          lines: [
          { account_id: "e:food", debit: 350 },
          { account_id: "a:kbank", credit: 100 },
        ],
      }),
    ).toThrow(/does not balance/);
  });

  it("rejects a line with both debit and credit", () => {
    expect(() =>
      recordJournalEntry(db, {
        date: "2026-02-01",
        description: "Bad",
          lines: [
          { account_id: "e:food", debit: 100, credit: 50 },
          { account_id: "a:kbank", credit: 50 },
        ],
      }),
    ).toThrow(/cannot debit and credit/);
  });

  it("rejects single-line entries", () => {
    expect(() =>
      recordJournalEntry(db, {
        date: "2026-02-01",
        description: "Bad",
          lines: [{ account_id: "e:food", debit: 100 }],
      }),
    ).toThrow(/at least two/);
  });

  it("computes balances from posted entries", () => {
    recordJournalEntry(db, {
      date: "2026-01-25",
      description: "Salary",
      lines: [
        { account_id: "a:kbank", debit: 50000 },
        { account_id: "i:salary", credit: 50000 },
      ],
    });
    recordJournalEntry(db, {
      date: "2026-02-01",
      description: "KTC purchase: groceries",
      lines: [
        { account_id: "e:food", debit: 1200 },
        { account_id: "l:ktc", credit: 1200 },
      ],
    });

    const balances = getAccountBalances(db);
    const byId = Object.fromEntries(balances.map(b => [b.id, b.balance]));
    expect(byId["a:kbank"]).toBe(50000);
    expect(byId["i:salary"]).toBe(50000);
    expect(byId["e:food"]).toBe(1200);
    expect(byId["l:ktc"]).toBe(1200);

    const nw = getNetWorth(db);
    expect(nw.assets).toBe(50000);
    expect(nw.liabilities).toBe(1200);
    expect(nw.net_worth).toBe(48800);
  });

  it("cascades journal entries and lines when a scanned_files row is deleted", () => {
    db.prepare(
      `INSERT INTO scanned_files (id, path, file_hash, mime, status)
       VALUES (?, ?, ?, ?, 'scanned')`,
    ).run("sf:1", "/tmp/x.pdf", "deadbeef", "application/pdf");

    recordJournalEntry(db, {
      date: "2026-02-01",
      description: "Tied to sf:1",
      source_file_id: "sf:1",
      lines: [
        { account_id: "e:food", debit: 500 },
        { account_id: "a:kbank", credit: 500 },
      ],
    });

    expect(listJournalLines(db)).toHaveLength(2);

    db.prepare(`DELETE FROM scanned_files WHERE id = ?`).run("sf:1");

    expect(listJournalLines(db)).toHaveLength(0);
    const entryCount = db.prepare(`SELECT COUNT(*) as n FROM journal_entries`).get() as { n: number };
    expect(entryCount.n).toBe(0);
  });
});
