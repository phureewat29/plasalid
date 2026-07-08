import type Database from "libsql";

export function migrate(db: Database.Database): void {
  // Backward compatibility is not supported. If any legacy schema shape is
  // present — the conversation_history/hints tables, the old `postings` table,
  // the now-legacy `transfers` table (renamed to `transactions` this release),
  // provider/model columns on scanned_files, or a transfer_id column on
  // questions — all tables are dropped and rebuilt (data loss intended; the
  // user gets a fresh, empty ledger). The current shape (a `transactions`
  // table with a debit_account_id column and questions carrying
  // transaction_id) is NOT legacy. Fresh and already-migrated DBs are NOT
  // legacy, so they skip the wipe and every CREATE ... IF NOT EXISTS is a
  // no-op, making a second migrate() call idempotent.
  if (isLegacySchema(db)) {
    dropAllTables(db);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('asset','liability','income','expense','equity')),
      parent_id TEXT REFERENCES accounts(id),
      subtype TEXT,
      bank_name TEXT,
      account_number_masked TEXT,
      currency TEXT NOT NULL DEFAULT 'THB',
      due_day INTEGER,
      statement_day INTEGER,
      points_balance REAL,
      metadata_json TEXT,
      pii_flag INTEGER NOT NULL DEFAULT 0,
      has_question INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS accounts_parent_idx ON accounts(parent_id);
    CREATE INDEX IF NOT EXISTS accounts_type_idx ON accounts(type);

    CREATE TABLE IF NOT EXISTS merchants (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL UNIQUE,
      default_account_id TEXT REFERENCES accounts(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS merchant_aliases (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      normalized_pattern TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS merchant_aliases_merchant_idx ON merchant_aliases(merchant_id);

    CREATE TABLE IF NOT EXISTS scanned_files (
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

    CREATE TABLE IF NOT EXISTS transactions (
      id                TEXT PRIMARY KEY,
      group_id          TEXT,
      date              TEXT NOT NULL,
      description       TEXT NOT NULL,
      merchant_id       TEXT REFERENCES merchants(id),
      raw_descriptor    TEXT,
      source_file_id    TEXT REFERENCES scanned_files(id) ON DELETE CASCADE,
      source_page       INTEGER,
      debit_account_id  TEXT NOT NULL REFERENCES accounts(id),
      credit_account_id TEXT NOT NULL REFERENCES accounts(id),
      amount            INTEGER NOT NULL,
      currency          TEXT NOT NULL DEFAULT 'THB',
      code              TEXT,
      user_ref          TEXT,
      has_question      INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (amount > 0),
      CHECK (debit_account_id <> credit_account_id)
    );

    CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions(date);
    CREATE INDEX IF NOT EXISTS transactions_debit_account_idx ON transactions(debit_account_id);
    CREATE INDEX IF NOT EXISTS transactions_credit_account_idx ON transactions(credit_account_id);
    CREATE INDEX IF NOT EXISTS transactions_source_file_idx ON transactions(source_file_id);
    CREATE INDEX IF NOT EXISTS transactions_group_idx ON transactions(group_id);
    CREATE INDEX IF NOT EXISTS transactions_merchant_idx ON transactions(merchant_id);

    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      scan_id TEXT,
      file_id TEXT REFERENCES scanned_files(id) ON DELETE CASCADE,
      transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      kind TEXT,
      prompt TEXT NOT NULL,
      options_json TEXT,
      context_json TEXT,
      answer TEXT,
      resolved_at TEXT,
      deferred_until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS questions_scan_idx ON questions(scan_id);
    CREATE INDEX IF NOT EXISTS questions_deferred_idx ON questions(deferred_until);

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_passwords (
      id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL UNIQUE,
      password_encrypted TEXT NOT NULL,
      last_used_at TEXT,
      use_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Detects whether any legacy schema shape is present. Any of these signals is
 * conclusive:
 *   - the `conversation_history` / `hints` tables exist, or
 *   - the `postings` table exists (the old two-table ledger), or
 *   - the `transfers` table exists (the v0.12 single-table name, renamed to
 *     `transactions` this release), or
 *   - `scanned_files` still carries `provider` / `model` columns, or
 *   - `questions` still carries a `transfer_id` column.
 * The current shape — a `transactions` table (with a `debit_account_id`
 * column) and `questions` carrying `transaction_id` — is deliberately NOT a
 * signal, so the renamed ledger is never mistaken for the old two-table
 * `transactions` header. A fresh (empty) DB and an already-migrated clean DB
 * both return false, so the caller only wipes genuinely-legacy databases.
 * Nuke-and-recreate is intended: data loss on a legacy DB is accepted (the
 * user gets a fresh, empty ledger).
 */
function isLegacySchema(db: Database.Database): boolean {
  const legacyTable = db
    .prepare(
      `SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name IN ('conversation_history', 'hints', 'postings', 'transfers')
        LIMIT 1`,
    )
    .get();
  if (legacyTable) return true;

  const fileCols = db
    .prepare(`PRAGMA table_info(scanned_files)`)
    .all() as { name: string }[];
  if (fileCols.some(c => c.name === "provider" || c.name === "model")) return true;

  const questionCols = db
    .prepare(`PRAGMA table_info(questions)`)
    .all() as { name: string }[];
  return questionCols.some(c => c.name === "transfer_id");
}

/**
 * Drop every user table (nuke). Foreign-key enforcement is toggled off for the
 * teardown so drop order and cross-table references can't raise constraint
 * violations, then restored. Called only after isLegacySchema() confirms a
 * legacy DB; migrate() rebuilds the clean shape immediately afterwards.
 * (Safe to toggle the pragma here: migrate() runs outside any transaction.)
 */
function dropAllTables(db: Database.Database): void {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];

  db.pragma("foreign_keys = OFF");
  try {
    for (const { name } of tables) {
      db.exec(`DROP TABLE IF EXISTS "${name}"`);
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
