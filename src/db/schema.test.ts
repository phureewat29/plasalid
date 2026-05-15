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
      "concerns",
      "conversation_history",
      "file_passwords",
      "journal_entries",
      "journal_lines",
      "memories",
      "recurrences",
      "scanned_files",
      "settings",
    ];

    for (const t of expected) {
      expect(tables, `missing table: ${t}`).toContain(t);
    }
  });

  it("is idempotent", () => {
    const db = freshDb();
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });

  it("enforces journal_lines debit/credit invariant", () => {
    const db = freshDb();
    migrate(db);

    db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`)
      .run("a:test", "Test", "asset");
    db.prepare(
      `INSERT INTO journal_entries (id, date, description) VALUES (?, ?, ?)`
    ).run("je:1", "2026-01-01", "test");

    expect(() =>
      db.prepare(
        `INSERT INTO journal_lines (id, entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?, ?)`
      ).run("jl:1", "je:1", "a:test", 100, 50),
    ).toThrow();
  });
});
