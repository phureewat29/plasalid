import type Database from "libsql";

export interface Memory {
  id: number;
  content: string;
  category: string;
  created_at: string;
}

export function getMemories(db: Database.Database): Memory[] {
  return db.prepare(
    `SELECT id, content, category, created_at FROM memories ORDER BY created_at DESC`,
  ).all() as Memory[];
}

export function countMemories(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number };
  return row.n;
}

/**
 * Idempotent on (category, content): a verbatim repeat is a no-op. Semantic
 * dedup (different wording for the same rule) is the agent's job: the persona
 * tells it not to save what's already in the loaded memories.
 */
export function saveMemory(db: Database.Database, content: string, category = "general"): void {
  const existing = db
    .prepare(`SELECT 1 FROM memories WHERE category = ? AND content = ? LIMIT 1`)
    .get(category, content);
  if (existing) return;
  db.prepare(`INSERT INTO memories (content, category) VALUES (?, ?)`).run(content, category);
}

export function deleteMemory(db: Database.Database, id: number): Memory | null {
  const row = db
    .prepare(`SELECT id, content, category, created_at FROM memories WHERE id = ?`)
    .get(id) as Memory | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  return row;
}
