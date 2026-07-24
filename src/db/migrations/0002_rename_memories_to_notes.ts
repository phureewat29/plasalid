import type Database from "libsql";

export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE memories RENAME TO notes;

    -- Collapse the legacy free-form categories ('general', 'life_event', …)
    -- onto the default of the new rule|preference|fact taxonomy, leaving the
    -- two categories that carry over untouched.
    UPDATE notes SET category = 'fact' WHERE category NOT IN ('rule', 'preference', 'fact');
  `);
}
