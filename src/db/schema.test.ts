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
      "files",
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

describe("legacy DB migration (nuke + recreate)", () => {
  function tableNames(db: Database.Database): string[] {
    return db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all()
      .map((r: any) => r.name);
  }

  function filesCols(db: Database.Database): string[] {
    return (db.prepare(`PRAGMA table_info(files)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
  }

  /**
   * A v0.12-shaped DB: single-table `transfers` ledger (renamed to
   * `transactions`) plus `questions.transfer_id`. scanned_files already uses
   * `source` (provider/model predate v0.12), isolating `transfers` as the
   * detection signal. Seeds a row so the wipe can be asserted.
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
   * Pre-v0.12 shape: conversation_history/hints tables, provider/model
   * columns on scanned_files, and the old two-table `postings` ledger.
   * Guards that these still trigger the wipe now that a bare `transactions`
   * table doesn't.
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

  it("detects a v0.12 transfers-table DB and rebuilds the clean shape", () => {
    const db = v012Db();
    expect(() => migrate(db)).not.toThrow();

    const tables = tableNames(db);
    // The legacy single-table name is gone; the renamed table is present.
    expect(tables).not.toContain("transfers");
    for (const t of ["accounts", "merchants", "files", "transactions", "questions"]) {
      expect(tables, `missing table: ${t}`).toContain(t);
    }
    // questions carries transaction_id, not transfer_id.
    const qcols = (db.prepare(`PRAGMA table_info(questions)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(qcols).toContain("transaction_id");
    expect(qcols).not.toContain("transfer_id");
    // files has the current shape.
    const cols = filesCols(db);
    expect(cols).toContain("source");
    expect(cols).not.toContain("provider");
  });

  it("wipes all legacy data (fresh empty ledger, data loss is intended)", () => {
    const db = v012Db();
    migrate(db);

    expect(db.prepare(`SELECT COUNT(*) AS n FROM files`).get()).toMatchObject({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()).toMatchObject({ n: 0 });
    // The legacy single-table ledger no longer exists.
    expect(tableNames(db)).not.toContain("transfers");
  });

  it("detects the pre-v0.12 two-table (postings) shape and rebuilds clean", () => {
    const db = ancientLegacyDb();
    expect(() => migrate(db)).not.toThrow();

    const tables = tableNames(db);
    expect(tables).not.toContain("postings");
    expect(tables).not.toContain("conversation_history");
    expect(tables).not.toContain("hints");
    for (const t of ["accounts", "merchants", "files", "transactions", "questions"]) {
      expect(tables, `missing table: ${t}`).toContain(t);
    }
    const cols = filesCols(db);
    expect(cols).toContain("source");
    expect(cols).not.toContain("provider");
    expect(cols).not.toContain("model");
  });

  /**
   * Otherwise-current shape, but `transactions` predates `void_of` (void was
   * encoded as `code='void'` + `user_ref`). Isolates the missing column as
   * the detection signal.
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

  it("detects a transactions table missing void_of and rebuilds clean (closes the code='void' footgun)", () => {
    const db = preVoidOfDb();
    expect(() => migrate(db)).not.toThrow();

    const cols = (db.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("void_of");
    // Nuke-and-recreate: the pre-void_of row (and its code='void' encoding) is gone.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()).toMatchObject({ n: 0 });
  });

  /**
   * Immediately-previous shape: current except `files` is still
   * `scanned_files` and questions still carry `scan_id`. Every other signal
   * (`void_of`, `transaction_id`, no legacy tables) is absent, so
   * `scanned_files`'s mere existence alone must drive detection.
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

  it("detects the immediately-previous scanned_files/scan_id shape and rebuilds clean", () => {
    const db = previousShapeDb();
    expect(() => migrate(db)).not.toThrow();

    const tables = tableNames(db);
    // The old table name is gone; the renamed table is present.
    expect(tables).not.toContain("scanned_files");
    expect(tables).toContain("files");
    // questions carries batch_id, not scan_id.
    const qcols = (db.prepare(`PRAGMA table_info(questions)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(qcols).toContain("batch_id");
    expect(qcols).not.toContain("scan_id");
    // Nuke-and-recreate: the seeded row is gone.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM files`).get()).toMatchObject({ n: 0 });
  });

  it("does NOT treat the current shape as legacy (idempotent; data preserved)", () => {
    const db = freshDb();
    migrate(db); // builds the current clean shape: transactions + questions.transaction_id
    db.prepare(`INSERT INTO accounts (id, name, type) VALUES ('asset:a', 'A', 'asset'), ('asset:b', 'B', 'asset')`).run();
    db.prepare(
      `INSERT INTO transactions (id, date, description, debit_account_id, credit_account_id, amount, currency)
       VALUES ('tx:1', '2026-07-01', 'Coffee', 'asset:a', 'asset:b', 100, 'THB')`,
    ).run();

    /**
     * A second migrate() must not mistake the `transactions` table (with
     * debit_account_id) or questions.transaction_id for a legacy shape and
     * wipe it — the seeded rows surviving proves no nuke happened.
     */
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()).toMatchObject({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM accounts`).get()).toMatchObject({ n: 2 });
    const cols = filesCols(db);
    expect(cols).toContain("source");
    expect(cols).not.toContain("provider");
  });
});
