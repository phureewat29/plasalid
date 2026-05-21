import type Database from "libsql";

export function migrate(db: Database.Database): void {
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
      has_unknown INTEGER NOT NULL DEFAULT 0,
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
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS recurrences (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      frequency TEXT NOT NULL CHECK(frequency IN ('weekly','biweekly','monthly','annually')),
      amount_typical REAL,
      currency TEXT NOT NULL DEFAULT 'THB',
      first_seen_date TEXT,
      last_seen_date TEXT,
      next_expected_date TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS recurrences_account_idx ON recurrences(account_id);

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      merchant_id TEXT REFERENCES merchants(id),
      raw_descriptor TEXT,
      source_file_id TEXT REFERENCES scanned_files(id) ON DELETE CASCADE,
      source_page INTEGER,
      recurrence_id TEXT REFERENCES recurrences(id) ON DELETE SET NULL,
      has_unknown INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS transactions_recurrence_idx ON transactions(recurrence_id);
    CREATE INDEX IF NOT EXISTS transactions_source_file_idx ON transactions(source_file_id);
    CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions(date);
    CREATE INDEX IF NOT EXISTS transactions_merchant_idx ON transactions(merchant_id);

    CREATE TABLE IF NOT EXISTS postings (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      debit REAL NOT NULL DEFAULT 0,
      credit REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'THB',
      memo TEXT,
      pii_flag INTEGER NOT NULL DEFAULT 0,
      CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0))
    );

    CREATE INDEX IF NOT EXISTS postings_transaction_idx ON postings(transaction_id);
    CREATE INDEX IF NOT EXISTS postings_account_idx ON postings(account_id);

    CREATE TABLE IF NOT EXISTS unknowns (
      id TEXT PRIMARY KEY,
      file_id TEXT REFERENCES scanned_files(id) ON DELETE CASCADE,
      transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      kind TEXT,
      prompt TEXT NOT NULL,
      options_json TEXT,
      context_json TEXT,
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

    CREATE TABLE IF NOT EXISTS action_log (
      id TEXT PRIMARY KEY,
      correlation_id TEXT NOT NULL,
      command TEXT NOT NULL,
      user_input TEXT,
      action_type TEXT NOT NULL CHECK(action_type IN (
        'create_account','update_account_metadata','record_transaction','adjust_balance',
        'create_merchant','update_merchant_default'
      )),
      target_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reverted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS action_log_correlation_idx ON action_log(correlation_id);
    CREATE INDEX IF NOT EXISTS action_log_created_idx ON action_log(created_at);
  `);

  ensureColumn(db, "unknowns", "context_json", "TEXT");
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
