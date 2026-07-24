import { describe, it, expect } from "vitest";
import Database from "libsql";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, applyMigrations } from "./schema.js";
import type { Migration } from "./migrations/index.js";
import * as baseline from "./migrations/0001_baseline.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

function tableNames(db: Database.Database): string[] {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((r: any) => r.name);
}

function versions(db: Database.Database): number[] {
  return (db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as {
    version: number;
  }[]).map((r) => r.version);
}

function rowCount(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

describe("migrate", () => {
  it("creates the expected tables", () => {
    const db = freshDb();
    migrate(db);

    const tables = tableNames(db).sort();

    const expected = [
      "accounts",
      "questions",
      "file_passwords",
      "notes",
      "merchant_aliases",
      "merchants",
      "files",
      "settings",
      "transactions",
    ];

    for (const t of expected) {
      expect(tables, `missing table: ${t}`).toContain(t);
    }

    // A fresh db replays the full chain: 0001 creates `memories`, 0002 renames
    // it, so the finished schema exposes `notes` and never `memories`.
    expect(tables).not.toContain("memories");

    expect(tables).not.toContain("journal_entries");
    expect(tables).not.toContain("journal_lines");
    expect(tables).not.toContain("rules");
    expect(tables).not.toContain("recurrences");
    // Interactive-AI subsystems dropped in the harness cut.
    expect(tables).not.toContain("conversation_history");
    expect(tables).not.toContain("hints");
  });

  it("creates files with source and without provider/model", () => {
    const db = freshDb();
    migrate(db);

    const cols = (db.prepare(`PRAGMA table_info(files)`).all() as { name: string }[])
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

  it("records each applied version once and preserves data across re-migration", () => {
    const db = freshDb();
    migrate(db);
    db.prepare(
      `INSERT INTO accounts (id, name, type) VALUES ('asset:a', 'A', 'asset'), ('asset:b', 'B', 'asset')`,
    ).run();
    db.prepare(
      `INSERT INTO transactions (id, date, description, debit_account_id, credit_account_id, amount, currency)
       VALUES ('tx:1', '2026-07-01', 'Coffee', 'asset:a', 'asset:b', 100, 'THB')`,
    ).run();

    // A second migrate() takes the up-to-date fast path: no guard, no wipe.
    expect(() => migrate(db)).not.toThrow();

    expect(rowCount(db, "transactions")).toBe(1);
    expect(rowCount(db, "accounts")).toBe(2);
    expect(versions(db)).toEqual([1, 2]);
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

describe("migration 0002: memories -> notes", () => {
  it("renames the table and normalizes legacy categories, preserving rule/preference", () => {
    const db = freshDb();
    // Build a real version-1 db (baseline only), so `memories` still exists and
    // schema_migrations is at 1 — the path a pre-0002 database upgrades from.
    applyMigrations(db, [baseline]);
    const seed = db.prepare(`INSERT INTO memories (content, category) VALUES (?, ?)`);
    seed.run("a general note", "general");
    seed.run("a life event", "life_event");
    seed.run("a stated preference", "preference");
    seed.run("a hard rule", "rule");

    // The full chain now carries 0002.
    migrate(db);

    expect(versions(db)).toEqual([1, 2]);
    expect(tableNames(db)).toContain("notes");
    expect(tableNames(db)).not.toContain("memories");

    const rows = db
      .prepare(`SELECT content, category FROM notes`)
      .all() as { content: string; category: string }[];
    const byContent = Object.fromEntries(rows.map((r) => [r.content, r.category]));
    // Legacy categories collapse to the new default; rule/preference survive.
    expect(byContent["a general note"]).toBe("fact");
    expect(byContent["a life event"]).toBe("fact");
    expect(byContent["a stated preference"]).toBe("preference");
    expect(byContent["a hard rule"]).toBe("rule");
  });
});

describe("transactions table (TigerBeetle-core)", () => {
  function seededDb() {
    const db = freshDb();
    migrate(db);
    db.prepare(`INSERT INTO accounts (id, name, type) VALUES ('asset', 'Assets', 'asset')`).run();
    db.prepare(
      `INSERT INTO accounts (id, name, type, parent_id) VALUES ('asset:a', 'A', 'asset', 'asset')`,
    ).run();
    db.prepare(
      `INSERT INTO accounts (id, name, type, parent_id) VALUES ('asset:b', 'B', 'asset', 'asset')`,
    ).run();
    return db;
  }

  function insertTransaction(
    db: Database.Database,
    over: Partial<{ id: string; debit: string; credit: string; amount: number }> = {},
  ) {
    return db
      .prepare(
        `INSERT INTO transactions (id, date, description, debit_account_id, credit_account_id, amount, currency)
         VALUES (?, '2026-01-01', 'x', ?, ?, ?, 'THB')`,
      )
      .run(over.id ?? "tx:1", over.debit ?? "asset:a", over.credit ?? "asset:b", over.amount ?? 100);
  }

  it("has the expected columns", () => {
    const db = seededDb();
    const cols = (db.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const c of [
      "id", "group_id", "date", "description", "merchant_id", "raw_descriptor",
      "source_file_id", "source_page", "debit_account_id", "credit_account_id",
      "amount", "currency", "code", "user_ref", "void_of", "has_question", "created_at",
    ]) {
      expect(cols, `missing column: ${c}`).toContain(c);
    }
  });

  it("adds a transaction_id column to questions", () => {
    const db = seededDb();
    const cols = (db.prepare(`PRAGMA table_info(questions)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("transaction_id");
    // questions carries transaction_id, not transfer_id.
    expect(cols).not.toContain("transfer_id");
  });

  it("accepts a well-formed transaction", () => {
    const db = seededDb();
    expect(() => insertTransaction(db)).not.toThrow();
  });

  it("rejects amount <= 0 (CHECK)", () => {
    const db = seededDb();
    expect(() => insertTransaction(db, { amount: 0 })).toThrow();
    expect(() => insertTransaction(db, { amount: -100 })).toThrow();
  });

  it("rejects debit == credit (CHECK)", () => {
    const db = seededDb();
    expect(() => insertTransaction(db, { debit: "asset:a", credit: "asset:a" })).toThrow();
  });
});

describe("legacy DB guard (non-destructive)", () => {
  function questionCols(db: Database.Database): string[] {
    return (db.prepare(`PRAGMA table_info(questions)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
  }

  function transactionCols(db: Database.Database): string[] {
    return (db.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
  }

  /**
   * A v0.12-shaped DB: single-table `transfers` ledger (renamed to
   * `transactions`) plus `questions.transfer_id`. Seeds rows so their survival
   * proves migrate() never dropped anything.
   */
  function v012Db(): Database.Database {
    const db = freshDb();
    db.exec(`
      CREATE TABLE scanned_files (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        file_hash TEXT NOT NULL UNIQUE,
        mime TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','scanned','failed')),
        raw_text TEXT,
        scanned_at TEXT,
        source TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE merchants (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL UNIQUE,
        default_account_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL
      );
      CREATE TABLE transfers (
        id TEXT PRIMARY KEY,
        group_id TEXT,
        date TEXT NOT NULL,
        description TEXT NOT NULL,
        merchant_id TEXT REFERENCES merchants(id),
        source_file_id TEXT REFERENCES scanned_files(id) ON DELETE CASCADE,
        source_page INTEGER,
        debit_account_id TEXT NOT NULL,
        credit_account_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'THB',
        has_question INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        scan_id TEXT,
        file_id TEXT REFERENCES scanned_files(id) ON DELETE CASCADE,
        transfer_id TEXT REFERENCES transfers(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(`INSERT INTO accounts (id, name, type) VALUES ('asset:a', 'A', 'asset'), ('asset:b', 'B', 'asset')`).run();
    db.prepare(
      `INSERT INTO scanned_files (id, path, file_hash, mime, status, source, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("f:1", "/tmp/a.pdf", "hash-1", "application/pdf", "scanned", "external", "2026-07-01 10:00:00");
    db.prepare(
      `INSERT INTO transfers (id, date, description, source_file_id, debit_account_id, credit_account_id, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("tf:1", "2026-07-01", "Coffee", "f:1", "asset:a", "asset:b", 15000);
    return db;
  }

  /**
   * Pre-v0.12 shape: conversation_history/hints tables, provider/model columns
   * on scanned_files, and the old two-table `postings` ledger.
   */
  function ancientLegacyDb(): Database.Database {
    const db = freshDb();
    db.exec(`
      CREATE TABLE conversation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE TABLE hints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL
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
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        description TEXT NOT NULL
      );
      CREATE TABLE postings (
        id TEXT PRIMARY KEY,
        transaction_id TEXT REFERENCES transactions(id),
        account_id TEXT,
        amount INTEGER NOT NULL
      );
    `);
    db.prepare(`INSERT INTO conversation_history (role, content) VALUES (?, ?)`).run("user", "hi");
    db.prepare(`INSERT INTO hints (text) VALUES (?)`).run("a hint");
    db.prepare(
      `INSERT INTO scanned_files (id, path, file_hash, mime, status, provider, model, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("f:1", "/tmp/a.pdf", "hash-1", "application/pdf", "scanned", "anthropic", "claude-x", "2026-05-24 10:00:00");
    db.prepare(`INSERT INTO transactions (id, date, description) VALUES (?, ?, ?)`)
      .run("tx:1", "2026-05-01", "Coffee");
    return db;
  }

  /**
   * Otherwise-current shape, but `transactions` predates `void_of` (void was
   * encoded as `code='void'` + `user_ref`). Seeds the pre-void_of row.
   */
  function preVoidOfDb(): Database.Database {
    const db = freshDb();
    db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL
      );
      CREATE TABLE merchants (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL UNIQUE,
        default_account_id TEXT,
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
        source TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        group_id TEXT,
        date TEXT NOT NULL,
        description TEXT NOT NULL,
        merchant_id TEXT REFERENCES merchants(id),
        raw_descriptor TEXT,
        source_file_id TEXT REFERENCES scanned_files(id) ON DELETE CASCADE,
        source_page INTEGER,
        debit_account_id TEXT NOT NULL,
        credit_account_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'THB',
        code TEXT,
        user_ref TEXT,
        has_question INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        scan_id TEXT,
        file_id TEXT REFERENCES scanned_files(id) ON DELETE CASCADE,
        transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(
      `INSERT INTO accounts (id, name, type) VALUES ('asset:a', 'A', 'asset'), ('asset:b', 'B', 'asset')`,
    ).run();
    db.prepare(
      `INSERT INTO transactions (id, date, description, debit_account_id, credit_account_id, amount, currency, code, user_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("tx:dup", "2026-07-01", "Coffee", "asset:a", "asset:b", 15000, "THB", "void", "tx:orig");
    return db;
  }

  /**
   * Immediately-previous shape: current except `files` is still `scanned_files`
   * and questions still carry `scan_id`. Seeds a scanned_files row.
   */
  function previousShapeDb(): Database.Database {
    const db = freshDb();
    db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL
      );
      CREATE TABLE merchants (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL UNIQUE,
        default_account_id TEXT,
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
        source TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        group_id TEXT,
        date TEXT NOT NULL,
        description TEXT NOT NULL,
        merchant_id TEXT REFERENCES merchants(id),
        raw_descriptor TEXT,
        source_file_id TEXT REFERENCES scanned_files(id) ON DELETE CASCADE,
        source_page INTEGER,
        debit_account_id TEXT NOT NULL,
        credit_account_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'THB',
        code TEXT,
        user_ref TEXT,
        void_of TEXT,
        has_question INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        scan_id TEXT,
        file_id TEXT REFERENCES scanned_files(id) ON DELETE CASCADE,
        transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(
      `INSERT INTO accounts (id, name, type) VALUES ('asset:a', 'A', 'asset'), ('asset:b', 'B', 'asset')`,
    ).run();
    db.prepare(
      `INSERT INTO scanned_files (id, path, file_hash, mime, status, source, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("f:1", "/tmp/a.pdf", "hash-1", "application/pdf", "scanned", "external", "2026-07-01 10:00:00");
    return db;
  }

  it("refuses a v0.12 transfers-table DB and leaves its rows intact", () => {
    const db = v012Db();
    expect(() => migrate(db)).toThrow(/unrecognized legacy schema/i);
    // Nothing dropped: the legacy tables and their rows survive untouched.
    expect(tableNames(db)).toContain("transfers");
    expect(rowCount(db, "transfers")).toBe(1);
    expect(rowCount(db, "accounts")).toBe(2);
    expect(questionCols(db)).toContain("transfer_id");
  });

  it("refuses the pre-v0.12 postings shape and leaves its rows intact", () => {
    const db = ancientLegacyDb();
    expect(() => migrate(db)).toThrow(/unrecognized legacy schema/i);
    expect(tableNames(db)).toContain("conversation_history");
    expect(tableNames(db)).toContain("postings");
    expect(rowCount(db, "conversation_history")).toBe(1);
    expect(rowCount(db, "transactions")).toBe(1);
  });

  it("refuses a transactions table missing void_of and leaves its rows intact", () => {
    const db = preVoidOfDb();
    expect(() => migrate(db)).toThrow(/unrecognized legacy schema/i);
    expect(transactionCols(db)).not.toContain("void_of");
    // The pre-void_of row (with its code='void' encoding) is preserved.
    expect(rowCount(db, "transactions")).toBe(1);
  });

  it("refuses the immediately-previous scanned_files/scan_id shape and leaves its rows intact", () => {
    const db = previousShapeDb();
    expect(() => migrate(db)).toThrow(/unrecognized legacy schema/i);
    expect(tableNames(db)).toContain("scanned_files");
    expect(questionCols(db)).toContain("scan_id");
    expect(rowCount(db, "scanned_files")).toBe(1);
  });
});

describe("applyMigrations runner", () => {
  const m1: Migration = { up: (db) => db.exec(`CREATE TABLE t1 (id INTEGER PRIMARY KEY)`) };
  const m2: Migration = { up: (db) => db.exec(`CREATE TABLE t2 (id INTEGER PRIMARY KEY)`) };

  it("applies every pending migration and records its version", () => {
    const db = freshDb();
    applyMigrations(db, [m1, m2]);
    expect(tableNames(db)).toEqual(expect.arrayContaining(["t1", "t2"]));
    expect(versions(db)).toEqual([1, 2]);
  });

  it("is a no-op once the DB is at the latest version", () => {
    const db = freshDb();
    applyMigrations(db, [m1, m2]);
    // m1/m2 use bare CREATE TABLE, so a re-apply would throw "table exists";
    // not throwing proves the fast path returned before running anything.
    expect(() => applyMigrations(db, [m1, m2])).not.toThrow();
    expect(versions(db)).toEqual([1, 2]);
  });

  it("throws when the DB version is newer than the build", () => {
    const db = freshDb();
    applyMigrations(db, [m1, m2]);
    expect(() => applyMigrations(db, [m1])).toThrow(/newer than this build/i);
  });

  it("backs up an on-disk DB that already holds user tables before applying", () => {
    const dir = mkdtempSync(join(tmpdir(), "plasalid-migrate-"));
    try {
      const dbPath = join(dir, "db.sqlite");
      const db = new Database(dbPath);
      db.exec(`CREATE TABLE preexisting (id INTEGER PRIMARY KEY)`);
      db.prepare(`INSERT INTO preexisting (id) VALUES (1)`).run();

      applyMigrations(db, [m1, m2], dbPath);

      const baks = readdirSync(dir).filter(
        (n) => n.startsWith("db.sqlite.") && n.endsWith(".bak"),
      );
      expect(baks.length).toBe(1);
      expect(versions(db)).toEqual([1, 2]);
      expect(rowCount(db, "preexisting")).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
