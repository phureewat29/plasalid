import type Database from "libsql";

export function listHints(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT text FROM hints ORDER BY id ASC`)
    .all() as { text: string }[];
  return rows.map(r => r.text);
}

// Full-replace the table inside one transaction. No-op when texts is empty.
export function replaceHints(db: Database.Database, texts: readonly string[]): void {
  if (texts.length === 0) return;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM hints`).run();
    const insert = db.prepare(`INSERT INTO hints (text) VALUES (?)`);
    for (const text of texts) insert.run(text);
  });
  tx();
}

// Idempotent seed: only inserts when the table is currently empty.
export function seedDefaultHintsIfEmpty(
  db: Database.Database,
  defaults: readonly string[],
): void {
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM hints`).get() as { n: number }).n;
  if (count > 0) return;
  const insert = db.prepare(`INSERT INTO hints (text) VALUES (?)`);
  const tx = db.transaction(() => {
    for (const text of defaults) insert.run(text);
  });
  tx();
}
