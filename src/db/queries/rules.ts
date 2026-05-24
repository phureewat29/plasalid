import type Database from "libsql";

export interface Rule {
  id: number;
  kind: string;
  key: string;
  target: string;
  evidence_count: number;
  last_seen_at: string;
  created_at: string;
}

export interface UpsertRuleInput {
  kind: string;
  key: string;
  target: string;
}

/**
 * Insert a rule keyed on (kind, key), or — if one already exists — bump
 * `evidence_count`, refresh `last_seen_at`, and overwrite `target` with the
 * latest answer. The deterministic clarifier pass looks rules up via the
 * UNIQUE(kind, key) index, so this is the only write path that keeps the
 * rule store sparse and indexed.
 */
export function upsertRule(db: Database.Database, input: UpsertRuleInput): Rule {
  db.prepare(
    `INSERT INTO rules (kind, key, target)
     VALUES (?, ?, ?)
     ON CONFLICT(kind, key) DO UPDATE SET
       target = excluded.target,
       evidence_count = evidence_count + 1,
       last_seen_at = datetime('now')`,
  ).run(input.kind, input.key, input.target);
  const row = findRule(db, input.kind, input.key);
  if (!row) throw new Error(`upsertRule: row vanished after upsert (${input.kind}, ${input.key})`);
  return row;
}

export function findRule(db: Database.Database, kind: string, key: string): Rule | null {
  const row = db
    .prepare(
      `SELECT id, kind, key, target, evidence_count, last_seen_at, created_at
       FROM rules WHERE kind = ? AND key = ?`,
    )
    .get(kind, key) as Rule | undefined;
  return row ?? null;
}

export interface ListRulesOptions {
  kind?: string;
  limit?: number;
}

export function listRules(db: Database.Database, opts: ListRulesOptions = {}): Rule[] {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
  if (opts.kind) {
    return db
      .prepare(
        `SELECT id, kind, key, target, evidence_count, last_seen_at, created_at
         FROM rules WHERE kind = ?
         ORDER BY last_seen_at DESC LIMIT ?`,
      )
      .all(opts.kind, limit) as Rule[];
  }
  return db
    .prepare(
      `SELECT id, kind, key, target, evidence_count, last_seen_at, created_at
       FROM rules
       ORDER BY last_seen_at DESC LIMIT ?`,
    )
    .all(limit) as Rule[];
}

export function countRules(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM rules`).get() as { n: number };
  return row.n;
}

export function deleteRule(db: Database.Database, id: number): Rule | null {
  const row = db
    .prepare(
      `SELECT id, kind, key, target, evidence_count, last_seen_at, created_at
       FROM rules WHERE id = ?`,
    )
    .get(id) as Rule | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM rules WHERE id = ?`).run(id);
  return row;
}
