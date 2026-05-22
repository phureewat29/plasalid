import type Database from "libsql";

export function migrate(db: Database.Database): void {
  // One-shot renames for existing local data. Run BEFORE the CREATE TABLE
  // block so the legacy table/column names get carried forward under their
  // new identity instead of having a fresh empty `questions` table created
  // alongside the old `unknowns` table.
  ensureTableRenamed(db, "unknowns", "questions");
  ensureColumnRenamed(db, "accounts", "has_unknown", "has_question");
  ensureColumnRenamed(db, "transactions", "has_unknown", "has_question");

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
      has_question INTEGER NOT NULL DEFAULT 0,
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS questions_scan_idx ON questions(scan_id);

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

  ensureColumn(db, "questions", "context_json", "TEXT");
  ensureColumn(db, "questions", "scan_id", "TEXT");
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

/**
 * Rename a table on existing databases. No-op when the source table is gone
 * (already renamed or never existed). Safe to call before `CREATE TABLE IF
 * NOT EXISTS` so old data is carried forward under the new name instead of
 * sitting beside a fresh empty table.
 */
function ensureTableRenamed(
  db: Database.Database,
  oldName: string,
  newName: string,
): void {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(oldName);
  if (!exists) return;
  db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
}

/**
 * Rename a column on existing databases. No-op when the source column is
 * gone. Pairs with `ensureTableRenamed` for one-shot schema migrations.
 */
function ensureColumnRenamed(
  db: Database.Database,
  table: string,
  oldCol: string,
  newCol: string,
): void {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table);
  if (!tableExists) return;
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === oldCol)) return;
  db.exec(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
}
