import type Database from "libsql";
import { randomUUID } from "crypto";

export interface ConcernTarget {
  entry_id: string | null;
  account_id: string | null;
}

export interface RecordConcernInput extends ConcernTarget {
  file_id: string | null;
  prompt: string;
  options?: string[];
}

export interface OpenConcernRow {
  id: string;
  file_id: string | null;
  entry_id: string | null;
  account_id: string | null;
  prompt: string;
  options_json: string | null;
  created_at: string;
}

/**
 * Insert a new concerns row and flip the `has_concern` boolean on whichever
 * target (entry / account) was named. Returns the new `cn:<uuid>` id.
 */
export function recordConcern(db: Database.Database, input: RecordConcernInput): string {
  const id = `cn:${randomUUID()}`;
  db.prepare(
    `INSERT INTO concerns (id, file_id, entry_id, account_id, prompt, options_json) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.file_id,
    input.entry_id,
    input.account_id,
    input.prompt,
    input.options ? JSON.stringify(input.options) : null,
  );
  if (input.entry_id) {
    db.prepare(`UPDATE journal_entries SET has_concern = 1 WHERE id = ?`).run(input.entry_id);
  }
  if (input.account_id) {
    db.prepare(`UPDATE accounts SET has_concern = 1 WHERE id = ?`).run(input.account_id);
  }
  return id;
}

/**
 * Mark an existing concern as resolved with the user's answer and, if no other
 * open concerns reference the same target, clear the target's `has_concern`
 * flag. Returns the concern's target so callers can log or react.
 */
export function resolveConcern(db: Database.Database, id: string, answer: string): ConcernTarget | null {
  const target = getConcernTarget(db, id);
  if (!target) return null;
  db.prepare(`UPDATE concerns SET answer = ?, resolved_at = datetime('now') WHERE id = ?`).run(answer, id);
  maybeClearHasConcernFlags(db, target);
  return target;
}

/**
 * Look up the entry/account a concern is attached to. Returns null when the
 * concern id doesn't exist.
 */
export function getConcernTarget(db: Database.Database, id: string): ConcernTarget | null {
  const row = db
    .prepare(`SELECT entry_id, account_id FROM concerns WHERE id = ?`)
    .get(id) as ConcernTarget | undefined;
  return row ?? null;
}

/**
 * Clear `has_concern` on the named entry / account if no other open concerns
 * still reference it. Safe to call after any concern resolution; idempotent.
 */
export function maybeClearHasConcernFlags(db: Database.Database, target: ConcernTarget): void {
  if (target.entry_id) {
    const open = db
      .prepare(`SELECT 1 FROM concerns WHERE entry_id = ? AND resolved_at IS NULL LIMIT 1`)
      .get(target.entry_id);
    if (!open) db.prepare(`UPDATE journal_entries SET has_concern = 0 WHERE id = ?`).run(target.entry_id);
  }
  if (target.account_id) {
    const open = db
      .prepare(`SELECT 1 FROM concerns WHERE account_id = ? AND resolved_at IS NULL LIMIT 1`)
      .get(target.account_id);
    if (!open) db.prepare(`UPDATE accounts SET has_concern = 0 WHERE id = ?`).run(target.account_id);
  }
}

export interface CountOpenConcernsScope {
  file_id?: string;
  entry_id?: string;
  account_id?: string;
}

export function countOpenConcerns(db: Database.Database, scope: CountOpenConcernsScope = {}): number {
  const conditions = ["resolved_at IS NULL"];
  const params: any[] = [];
  if (scope.file_id)    { conditions.push("file_id = ?");    params.push(scope.file_id); }
  if (scope.entry_id)   { conditions.push("entry_id = ?");   params.push(scope.entry_id); }
  if (scope.account_id) { conditions.push("account_id = ?"); params.push(scope.account_id); }
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM concerns WHERE ${conditions.join(" AND ")}`)
    .get(...params) as { n: number };
  return row.n;
}

export function listOpenConcerns(db: Database.Database, limit = 50): OpenConcernRow[] {
  const capped = Math.min(Math.max(limit, 1), 200);
  return db.prepare(
    `SELECT id, file_id, entry_id, account_id, prompt, options_json, created_at
     FROM concerns
     WHERE resolved_at IS NULL
     ORDER BY created_at ASC
     LIMIT ?`,
  ).all(capped) as OpenConcernRow[];
}
