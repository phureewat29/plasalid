import type Database from "libsql";

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('asset','liability','income','expense','equity')),
      subtype TEXT,
      bank_name TEXT,
      account_number_masked TEXT,
      currency TEXT NOT NULL DEFAULT 'THB',
      due_day INTEGER,
      statement_day INTEGER,
      points_balance REAL,
      metadata_json TEXT,
      pii_flag INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scanned_files (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      file_hash TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','scanned','needs_input','failed')),
      raw_text TEXT,
      scanned_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      source_file_id TEXT REFERENCES scanned_files(id) ON DELETE CASCADE,
      source_page INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS journal_lines (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      debit REAL NOT NULL DEFAULT 0,
      credit REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'THB',
      memo TEXT,
      pii_flag INTEGER NOT NULL DEFAULT 0,
      CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0))
    );

    CREATE INDEX IF NOT EXISTS journal_lines_entry_idx ON journal_lines(entry_id);
    CREATE INDEX IF NOT EXISTS journal_lines_account_idx ON journal_lines(account_id);
    CREATE INDEX IF NOT EXISTS journal_entries_source_file_idx ON journal_entries(source_file_id);
    CREATE INDEX IF NOT EXISTS journal_entries_date_idx ON journal_entries(date);

    CREATE TABLE IF NOT EXISTS pending_questions (
      id TEXT PRIMARY KEY,
      file_id TEXT REFERENCES scanned_files(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      options_json TEXT,
      answer TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
