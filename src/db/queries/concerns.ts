import type Database from "libsql";
import { randomUUID } from "crypto";

export interface ConcernTarget {
  transaction_id: string | null;
  account_id: string | null;
}

export interface RecordConcernInput extends ConcernTarget {
  file_id: string | null;
  kind?: string | null;
  prompt: string;
  options?: string[];
}

export interface OpenConcernRow {
  id: string;
  file_id: string | null;
  transaction_id: string | null;
  account_id: string | null;
  kind: string | null;
  prompt: string;
  options_json: string | null;
  created_at: string;
}

/**
 * Insert a new concerns row and flip the `has_concern` boolean on whichever
 * target (transaction / account) was named. Returns the new `cn:<uuid>` id.
 */
export function recordConcern(db: Database.Database, input: RecordConcernInput): string {
  const id = `cn:${randomUUID()}`;
  db.prepare(
    `INSERT INTO concerns (id, file_id, transaction_id, account_id, kind, prompt, options_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.file_id,
    input.transaction_id,
    input.account_id,
    input.kind ?? null,
    input.prompt,
    input.options ? JSON.stringify(input.options) : null,
  );
  if (input.transaction_id) {
    db.prepare(`UPDATE transactions SET has_concern = 1 WHERE id = ?`).run(input.transaction_id);
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
 * Look up the transaction/account a concern is attached to. Returns null when
 * the concern id doesn't exist.
 */
export function getConcernTarget(db: Database.Database, id: string): ConcernTarget | null {
  const row = db
    .prepare(`SELECT transaction_id, account_id FROM concerns WHERE id = ?`)
    .get(id) as ConcernTarget | undefined;
  return row ?? null;
}

/**
 * Clear `has_concern` on the named transaction / account if no other open concerns
 * still reference it. Safe to call after any concern resolution; idempotent.
 */
export function maybeClearHasConcernFlags(db: Database.Database, target: ConcernTarget): void {
  if (target.transaction_id) {
    const open = db
      .prepare(`SELECT 1 FROM concerns WHERE transaction_id = ? AND resolved_at IS NULL LIMIT 1`)
      .get(target.transaction_id);
    if (!open) db.prepare(`UPDATE transactions SET has_concern = 0 WHERE id = ?`).run(target.transaction_id);
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
  transaction_id?: string;
  account_id?: string;
  kind?: string;
}

export function countOpenConcerns(db: Database.Database, scope: CountOpenConcernsScope = {}): number {
  const conditions = ["resolved_at IS NULL"];
  const params: any[] = [];
  if (scope.file_id)        { conditions.push("file_id = ?");        params.push(scope.file_id); }
  if (scope.transaction_id) { conditions.push("transaction_id = ?"); params.push(scope.transaction_id); }
  if (scope.account_id)     { conditions.push("account_id = ?");     params.push(scope.account_id); }
  if (scope.kind)           { conditions.push("kind = ?");           params.push(scope.kind); }
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM concerns WHERE ${conditions.join(" AND ")}`)
    .get(...params) as { n: number };
  return row.n;
}

export function listOpenConcerns(db: Database.Database, limit = 50): OpenConcernRow[] {
  const capped = Math.min(Math.max(limit, 1), 200);
  return db.prepare(
    `SELECT id, file_id, transaction_id, account_id, kind, prompt, options_json, created_at
     FROM concerns
     WHERE resolved_at IS NULL
     ORDER BY created_at ASC
     LIMIT ?`,
  ).all(capped) as OpenConcernRow[];
}
