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
      "file_passwords",
      "memories",
      "merchant_aliases",
      "merchants",
      "postings",
      "scanned_files",
      "settings",
      "transactions",
    ];

    for (const t of expected) {
      expect(tables, `missing table: ${t}`).toContain(t);
    }

    expect(tables).not.toContain("journal_entries");
    expect(tables).not.toContain("journal_lines");
    expect(tables).not.toContain("rules");
    expect(tables).not.toContain("recurrences");
    // Interactive-AI subsystems dropped in the harness cut.
    expect(tables).not.toContain("conversation_history");
    expect(tables).not.toContain("hints");
  });

  it("creates scanned_files with source and without provider/model", () => {
    const db = freshDb();
    migrate(db);

    const cols = (db.prepare(`PRAGMA table_info(scanned_files)`).all() as { name: string }[])
      .map((c) => c.name);
    expect(cols).toContain("source");
    expect(cols).not.toContain("provider");
    expect(cols).not.toContain("model");
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

describe("legacy DB migration (nuke + recreate)", () => {
  /**
   * Build a SIMULATED pre-harness-cut DB by hand-executing the OLD DDL:
   * conversation_history + hints tables, and scanned_files WITH provider/model
   * and WITHOUT source. Seeds a scanned_files row (provider='anthropic') plus a
   * referencing transaction so we can assert the wipe removed the old data.
   * Backward compatibility is NOT required — migrate() is expected to detect
   * this shape and drop everything before rebuilding the clean schema.
   */
  function legacyDb(): Database.Database {
    const db = freshDb();
    db.exec(`
      CREATE TABLE conversation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE hints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE scanned_files (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        file_hash TEXT NOT NULL UNIQUE,
        mime TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','scanned','failed')),
        raw_text TEXT,
        scanned_at TEXT,
        provider TEXT,
        model TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE merchants (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL UNIQUE,
        default_account_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        description TEXT NOT NULL,
        merchant_id TEXT REFERENCES merchants(id),
        raw_descriptor TEXT,
        source_file_id TEXT REFERENCES scanned_files(id) ON DELETE CASCADE,
        source_page INTEGER,
        has_question INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(`INSERT INTO conversation_history (role, content) VALUES (?, ?)`)
      .run("user", "hi");
    db.prepare(`INSERT INTO hints (text) VALUES (?)`).run("a hint");
    db.prepare(
      `INSERT INTO scanned_files (id, path, file_hash, mime, status, provider, model, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("f:1", "/tmp/a.pdf", "hash-1", "application/pdf", "scanned", "anthropic", "claude-x", "2026-05-24 10:00:00");
    db.prepare(
      `INSERT INTO transactions (id, date, description, source_file_id) VALUES (?, ?, ?, ?)`,
    ).run("tx:1", "2026-05-01", "Coffee", "f:1");
    return db;
  }

  function tableNames(db: Database.Database): string[] {
    return db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all()
      .map((r: any) => r.name);
  }

  function scannedFilesCols(db: Database.Database): string[] {
    return (db.prepare(`PRAGMA table_info(scanned_files)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
  }

  it("detects a legacy DB and rebuilds the clean shape without error", () => {
    const db = legacyDb();
    expect(() => migrate(db)).not.toThrow();

    const tables = tableNames(db);
    // Deleted subsystems are gone and not recreated.
    expect(tables).not.toContain("conversation_history");
    expect(tables).not.toContain("hints");
    // Clean schema is present.
    for (const t of ["accounts", "merchants", "scanned_files", "transactions", "postings", "questions"]) {
      expect(tables, `missing table: ${t}`).toContain(t);
    }
    // scanned_files is the new shape.
    const cols = scannedFilesCols(db);
    expect(cols).toContain("source");
    expect(cols).not.toContain("provider");
    expect(cols).not.toContain("model");
  });

  it("wipes all legacy data (fresh empty ledger, data loss is intended)", () => {
    const db = legacyDb();
    migrate(db);

    expect(db.prepare(`SELECT COUNT(*) AS n FROM scanned_files`).get()).toMatchObject({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()).toMatchObject({ n: 0 });
    // The old provider-scanned file is gone.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM scanned_files WHERE id = 'f:1'`).get()).toMatchObject({
      n: 0,
    });
  });

  it("is idempotent: a second migrate() does not re-nuke or throw", () => {
    const db = legacyDb();
    migrate(db); // nuke + recreate

    // Insert into the freshly-created clean schema, then migrate again.
    db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`)
      .run("asset", "Assets", "asset");
    expect(() => migrate(db)).not.toThrow();

    // The row survives — proving the second pass did NOT treat the clean DB as
    // legacy and wipe it.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM accounts`).get()).toMatchObject({ n: 1 });
    const cols = scannedFilesCols(db);
    expect(cols).toContain("source");
    expect(cols).not.toContain("provider");
  });
});
