import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { BufferedWriteContext } from "./buffer.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`).run("asset", "Assets", "asset");
  db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`).run("expense", "Expenses", "expense");
  db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`).run("asset:cash", "Cash", "asset", "asset");
  db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`).run("expense:food", "Food", "expense", "expense");
  db.prepare(
    `INSERT INTO scanned_files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, 'pending')`,
  ).run("sf:test", "/x.pdf", "deadbeef", "application/pdf");
  return db;
}

describe("BufferedWriteContext", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("queues transactions and unknowns without touching the DB until commit()", () => {
    const buf = new BufferedWriteContext("x.pdf");
    const transactionId = buf.appendTransaction({
      date: "2026-01-15",
      description: "Lunch",
      postings: [
        { account_id: "expense:food", debit: 100 },
        { account_id: "asset:cash", credit: 100 },
      ],
    });
    buf.appendUnknown({ transaction_id: transactionId, account_id: null, prompt: "Is this category right?" });

    expect(db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()).toMatchObject({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM unknowns`).get()).toMatchObject({ n: 0 });

    const counts = buf.commit(db, "sf:test");
    expect(counts).toEqual({ transactions: 1, unknowns: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()).toMatchObject({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM unknowns`).get()).toMatchObject({ n: 1 });

    const unknown = db.prepare(`SELECT transaction_id FROM unknowns LIMIT 1`).get() as { transaction_id: string };
    expect(unknown.transaction_id).toBe(transactionId);
  });

  it("auto-balances imbalanced transactions with an equity:adjustments posting", () => {
    const buf = new BufferedWriteContext("x.pdf");
    buf.appendTransaction({
      date: "2026-01-15",
      description: "Balanced transaction",
      postings: [
        { account_id: "expense:food", debit: 100 },
        { account_id: "asset:cash", credit: 100 },
      ],
    });
    const imbalancedId = buf.appendTransaction({
      date: "2026-01-16",
      description: "AI misread this row",
      postings: [
        { account_id: "expense:food", debit: 100 },
        { account_id: "asset:cash", credit: 50 },
      ],
    });

    expect(() => buf.commit(db, "sf:test")).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()).toMatchObject({ n: 2 });
    const onImbalanced = db
      .prepare(`SELECT account_id, debit, credit FROM postings WHERE transaction_id = ?`)
      .all(imbalancedId) as { account_id: string; debit: number; credit: number }[];
    expect(onImbalanced).toHaveLength(3);
    const adjustment = onImbalanced.find(p => p.account_id === "equity:adjustments");
    expect(adjustment).toEqual({ account_id: "equity:adjustments", debit: 0, credit: 50 });
  });

  it("rolls back the DB on a real fatal error (foreign-key violation)", () => {
    const buf = new BufferedWriteContext("x.pdf");
    buf.appendTransaction({
      date: "2026-01-15",
      description: "Good transaction",
      postings: [
        { account_id: "expense:food", debit: 100 },
        { account_id: "asset:cash", credit: 100 },
      ],
    });
    buf.appendTransaction({
      date: "2026-01-16",
      description: "References a missing account",
      postings: [
        { account_id: "expense:nonexistent", debit: 100 },
        { account_id: "asset:cash", credit: 100 },
      ],
    });

    expect(() => buf.commit(db, "sf:test")).toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()).toMatchObject({ n: 0 });
  });

  it("markDone records the summary", () => {
    const buf = new BufferedWriteContext("x.pdf");
    expect(buf.isDone).toBe(false);
    buf.markDone("Parsed 3 transactions.");
    expect(buf.isDone).toBe(true);
    expect(buf.doneSummary).toBe("Parsed 3 transactions.");
  });
});
