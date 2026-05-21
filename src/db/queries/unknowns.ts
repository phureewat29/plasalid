import type Database from "libsql";
import { randomUUID } from "crypto";

export interface UnknownTarget {
  transaction_id: string | null;
  account_id: string | null;
}

export interface RecordUnknownInput extends UnknownTarget {
  file_id: string | null;
  kind?: string | null;
  prompt: string;
  options?: string[];
  /** Kind-specific structured context (e.g. partner ids for similar_accounts). */
  context?: Record<string, unknown> | null;
}

export interface OpenUnknownRow {
  id: string;
  file_id: string | null;
  transaction_id: string | null;
  account_id: string | null;
  kind: string | null;
  prompt: string;
  options_json: string | null;
  context_json: string | null;
  created_at: string;
}

/**
 * Insert a new unknowns row and flip the `has_unknown` boolean on whichever
 * target (transaction / account) was named. Returns the new id. The id keeps
 * the historical `cn:` prefix — it's opaque and nothing else references it,
 * so the prefix is a no-op detail.
 */
export function recordUnknown(db: Database.Database, input: RecordUnknownInput): string {
  const id = `cn:${randomUUID()}`;
  db.prepare(
    `INSERT INTO unknowns (id, file_id, transaction_id, account_id, kind, prompt, options_json, context_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.file_id,
    input.transaction_id,
    input.account_id,
    input.kind ?? null,
    input.prompt,
    input.options ? JSON.stringify(input.options) : null,
    input.context ? JSON.stringify(input.context) : null,
  );
  if (input.transaction_id) {
    db.prepare(`UPDATE transactions SET has_unknown = 1 WHERE id = ?`).run(input.transaction_id);
  }
  if (input.account_id) {
    db.prepare(`UPDATE accounts SET has_unknown = 1 WHERE id = ?`).run(input.account_id);
  }
  return id;
}

/**
 * Mark an existing unknown as resolved with the user's answer and, if no other
 * open unknowns reference the same target, clear the target's `has_unknown`
 * flag. Returns the unknown's target so callers can log or react.
 */
export function resolveUnknown(db: Database.Database, id: string, answer: string): UnknownTarget | null {
  const target = getUnknownTarget(db, id);
  if (!target) return null;
  db.prepare(`UPDATE unknowns SET answer = ?, resolved_at = datetime('now') WHERE id = ?`).run(answer, id);
  maybeClearHasUnknownFlags(db, target);
  return target;
}

/**
 * Look up the transaction/account an unknown is attached to. Returns null when
 * the unknown id doesn't exist.
 */
export function getUnknownTarget(db: Database.Database, id: string): UnknownTarget | null {
  const row = db
    .prepare(`SELECT transaction_id, account_id FROM unknowns WHERE id = ?`)
    .get(id) as UnknownTarget | undefined;
  return row ?? null;
}

/**
 * Clear `has_unknown` on the named transaction / account if no other open
 * unknowns still reference it. Safe to call after any resolution; idempotent.
 */
function maybeClearHasUnknownFlags(db: Database.Database, target: UnknownTarget): void {
  if (target.transaction_id) {
    const open = db
      .prepare(`SELECT 1 FROM unknowns WHERE transaction_id = ? AND resolved_at IS NULL LIMIT 1`)
      .get(target.transaction_id);
    if (!open) db.prepare(`UPDATE transactions SET has_unknown = 0 WHERE id = ?`).run(target.transaction_id);
  }
  if (target.account_id) {
    const open = db
      .prepare(`SELECT 1 FROM unknowns WHERE account_id = ? AND resolved_at IS NULL LIMIT 1`)
      .get(target.account_id);
    if (!open) db.prepare(`UPDATE accounts SET has_unknown = 0 WHERE id = ?`).run(target.account_id);
  }
}

export interface CountOpenUnknownsScope {
  file_id?: string;
  transaction_id?: string;
  account_id?: string;
  kind?: string;
}

export function countOpenUnknowns(db: Database.Database, scope: CountOpenUnknownsScope = {}): number {
  const conditions = ["resolved_at IS NULL"];
  const params: any[] = [];
  if (scope.file_id)        { conditions.push("file_id = ?");        params.push(scope.file_id); }
  if (scope.transaction_id) { conditions.push("transaction_id = ?"); params.push(scope.transaction_id); }
  if (scope.account_id)     { conditions.push("account_id = ?");     params.push(scope.account_id); }
  if (scope.kind)           { conditions.push("kind = ?");           params.push(scope.kind); }
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM unknowns WHERE ${conditions.join(" AND ")}`)
    .get(...params) as { n: number };
  return row.n;
}

export function listOpenUnknowns(db: Database.Database, limit = 50): OpenUnknownRow[] {
  const capped = Math.min(Math.max(limit, 1), 200);
  return db.prepare(
    `SELECT id, file_id, transaction_id, account_id, kind, prompt, options_json, context_json, created_at
     FROM unknowns
     WHERE resolved_at IS NULL
     ORDER BY created_at ASC
     LIMIT ?`,
  ).all(capped) as OpenUnknownRow[];
}

/**
 * Open unknowns filtered by `kind`, ordered by the position of the kind in the
 * input array (priority) then by created_at. Pass `["uncategorized","duplicate"]`
 * to drain uncategorized rows before duplicates.
 *
 * `kind` is free-text TEXT in the schema; canonical values used by built-ins:
 *   uncategorized, duplicate, correlation, recurrence_candidate,
 *   similar_accounts, file_password
 */
export function listOpenUnknownsByKind(
  db: Database.Database,
  kinds: string[],
  limit = 50,
): OpenUnknownRow[] {
  if (kinds.length === 0) return [];
  const capped = Math.min(Math.max(limit, 1), 200);
  const placeholders = kinds.map(() => "?").join(",");
  const cases = kinds.map((_, i) => `WHEN ? THEN ${i}`).join(" ");
  return db.prepare(
    `SELECT id, file_id, transaction_id, account_id, kind, prompt, options_json, context_json, created_at
     FROM unknowns
     WHERE resolved_at IS NULL AND kind IN (${placeholders})
     ORDER BY CASE kind ${cases} ELSE ${kinds.length} END, created_at ASC
     LIMIT ?`,
  ).all(...kinds, ...kinds, capped) as OpenUnknownRow[];
}
