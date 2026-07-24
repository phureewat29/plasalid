import type Database from "libsql";

export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE memories RENAME TO notes;
    UPDATE notes SET category = 'fact' WHERE category NOT IN ('rule', 'preference', 'fact');
  `);
}
