import { describe, it, expect } from "vitest";
import Database from "libsql";
import { migrate } from "./schema.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

describe("migrate", () => {
  it("creates the expected tables", () => {
    const db = freshDb();
    migrate(db);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((r: any) => r.name);

    const expected = [
      "accounts",
      "questions",
      "conversation_history",
      "file_passwords",
      "memories",
      "merchant_aliases",
      "merchants",
      "postings",
      "recurrences",
      "scanned_files",
      "settings",
      "transactions",
    ];

    for (const t of expected) {
      expect(tables, `missing table: ${t}`).toContain(t);
    }

    expect(tables).not.toContain("journal_entries");
    expect(tables).not.toContain("journal_lines");
  });

  it("is idempotent", () => {
    const db = freshDb();
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });

  it("enforces postings debit/credit invariant", () => {
    const db = freshDb();
    migrate(db);

    db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`)
      .run("asset", "Assets", "asset");
    db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`)
      .run("asset:test", "Test", "asset", "asset");
    db.prepare(
      `INSERT INTO transactions (id, date, description) VALUES (?, ?, ?)`
    ).run("tx:1", "2026-01-01", "test");

    expect(() =>
      db.prepare(
        `INSERT INTO postings (id, transaction_id, account_id, debit, credit) VALUES (?, ?, ?, ?, ?)`
      ).run("p:1", "tx:1", "asset:test", 100, 50),
    ).toThrow();
  });

  it("accepts hierarchical accounts via parent_id", () => {
    const db = freshDb();
    migrate(db);

    db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`)
      .run("expense", "Expenses", "expense");
    db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`)
      .run("expense:food", "Food", "expense", "expense");
    db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`)
      .run("expense:food:groceries", "Groceries", "expense", "expense:food");

    const row = db
      .prepare(`SELECT parent_id FROM accounts WHERE id = ?`)
      .get("expense:food:groceries") as { parent_id: string };
    expect(row.parent_id).toBe("expense:food");
  });

  it("dedups merchant aliases on normalized_pattern", () => {
    const db = freshDb();
    migrate(db);

    db.prepare(`INSERT INTO merchants (id, canonical_name) VALUES (?, ?)`)
      .run("m:starbucks", "Starbucks");
    db.prepare(
      `INSERT INTO merchant_aliases (id, merchant_id, normalized_pattern) VALUES (?, ?, ?)`
    ).run("ma:1", "m:starbucks", "starbucks");

    expect(() =>
      db.prepare(
        `INSERT INTO merchant_aliases (id, merchant_id, normalized_pattern) VALUES (?, ?, ?)`
      ).run("ma:2", "m:starbucks", "starbucks"),
    ).toThrow();
  });
});
