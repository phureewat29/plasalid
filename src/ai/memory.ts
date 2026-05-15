import type Database from "libsql";

export interface ConversationMessage {
  role: string;
  content: string;
  created_at: string;
}

export interface Memory {
  id: number;
  content: string;
  category: string;
  created_at: string;
}

// ── Conversation history ────────────────────────────────────────────────────

export function getConversationHistory(db: Database.Database, limit = 20): ConversationMessage[] {
  return (db.prepare(
    `SELECT role, content, created_at FROM conversation_history ORDER BY id DESC LIMIT ?`,
  ).all(limit) as ConversationMessage[]).reverse();
}

export function saveMessage(db: Database.Database, role: "user" | "assistant", content: string): void {
  db.prepare(`INSERT INTO conversation_history (role, content) VALUES (?, ?)`).run(role, content);
}

// ── Memories ────────────────────────────────────────────────────────────────

export function getMemories(db: Database.Database): Memory[] {
  return db.prepare(
    `SELECT id, content, category, created_at FROM memories ORDER BY created_at DESC`,
  ).all() as Memory[];
}

/**
 * Idempotent on (category, content): a verbatim repeat is a no-op. Semantic
 * dedup (different wording for the same rule) is the agent's job — the persona
 * tells it not to save what's already in the loaded memories.
 */
export function saveMemory(db: Database.Database, content: string, category = "general"): void {
  const existing = db
    .prepare(`SELECT 1 FROM memories WHERE category = ? AND content = ? LIMIT 1`)
    .get(category, content);
  if (existing) return;
  db.prepare(`INSERT INTO memories (content, category) VALUES (?, ?)`).run(content, category);
}
