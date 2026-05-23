import type Database from "libsql";
import { randomUUID } from "crypto";

export interface QuestionTarget {
  transaction_id: string | null;
  account_id: string | null;
}

export interface RecordQuestionInput extends QuestionTarget {
  file_id: string | null;
  scan_id?: string | null;
  kind?: string | null;
  prompt: string;
  options?: string[];
  /** Kind-specific structured context (e.g. partner ids for similar_accounts). */
  context?: Record<string, unknown> | null;
}

export interface QuestionRow {
  id: string;
  scan_id: string | null;
  file_id: string | null;
  transaction_id: string | null;
  account_id: string | null;
  kind: string | null;
  prompt: string;
  options_json: string | null;
  context_json: string | null;
  created_at: string;
}

export interface ClosedQuestion {
  prompt: string;
  kind: string | null;
  answer: string;
}

/**
 * Insert a new questions row and flip the `has_question` boolean on whichever
 * target (transaction / account) was named. Returns the new id. The id keeps
 * the historical `cn:` prefix — it's opaque and nothing else references it,
 * so the prefix is a no-op detail.
 */
export function recordQuestion(db: Database.Database, input: RecordQuestionInput): string {
  const id = `cn:${randomUUID()}`;
  db.prepare(
    `INSERT INTO questions (id, scan_id, file_id, transaction_id, account_id, kind, prompt, options_json, context_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.scan_id ?? null,
    input.file_id,
    input.transaction_id,
    input.account_id,
    input.kind ?? null,
    input.prompt,
    input.options ? JSON.stringify(input.options) : null,
    input.context ? JSON.stringify(input.context) : null,
  );
  if (input.transaction_id) {
    db.prepare(`UPDATE transactions SET has_question = 1 WHERE id = ?`).run(input.transaction_id);
  }
  if (input.account_id) {
    db.prepare(`UPDATE accounts SET has_question = 1 WHERE id = ?`).run(input.account_id);
  }
  return id;
}

/**
 * Close a question by capturing its (prompt, kind, answer) tuple and
 * deleting the row outright. Returns the captured tuple so callers can
 * synthesize memory rules; returns null when the id doesn't exist.
 */
export function closeQuestion(
  db: Database.Database,
  id: string,
  answer: string,
): ClosedQuestion | null {
  const row = db
    .prepare(
      `SELECT prompt, kind, transaction_id, account_id FROM questions WHERE id = ?`,
    )
    .get(id) as
    | { prompt: string; kind: string | null; transaction_id: string | null; account_id: string | null }
    | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM questions WHERE id = ?`).run(id);
  maybeClearHasQuestionFlags(db, {
    transaction_id: row.transaction_id,
    account_id: row.account_id,
  });
  return { prompt: row.prompt, kind: row.kind, answer };
}

/**
 * Look up the transaction/account a question is attached to. Returns null when
 * the question id doesn't exist.
 */
export function getQuestionTarget(db: Database.Database, id: string): QuestionTarget | null {
  const row = db
    .prepare(`SELECT transaction_id, account_id FROM questions WHERE id = ?`)
    .get(id) as QuestionTarget | undefined;
  return row ?? null;
}

/**
 * Clear `has_question` on the named transaction / account if no other
 * questions still reference it. Safe to call after any resolution; idempotent.
 */
function maybeClearHasQuestionFlags(db: Database.Database, target: QuestionTarget): void {
  if (target.transaction_id) {
    const open = db
      .prepare(`SELECT 1 FROM questions WHERE transaction_id = ? LIMIT 1`)
      .get(target.transaction_id);
    if (!open) db.prepare(`UPDATE transactions SET has_question = 0 WHERE id = ?`).run(target.transaction_id);
  }
  if (target.account_id) {
    const open = db
      .prepare(`SELECT 1 FROM questions WHERE account_id = ? LIMIT 1`)
      .get(target.account_id);
    if (!open) db.prepare(`UPDATE accounts SET has_question = 0 WHERE id = ?`).run(target.account_id);
  }
}

export interface CountQuestionsScope {
  file_id?: string;
  transaction_id?: string;
  account_id?: string;
  kind?: string;
  scan_id?: string;
}

export function countQuestions(db: Database.Database, scope: CountQuestionsScope = {}): number {
  const conditions: string[] = [];
  const params: any[] = [];
  if (scope.file_id)        { conditions.push("file_id = ?");        params.push(scope.file_id); }
  if (scope.transaction_id) { conditions.push("transaction_id = ?"); params.push(scope.transaction_id); }
  if (scope.account_id)     { conditions.push("account_id = ?");     params.push(scope.account_id); }
  if (scope.kind)           { conditions.push("kind = ?");           params.push(scope.kind); }
  if (scope.scan_id)        { conditions.push("scan_id = ?");        params.push(scope.scan_id); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM questions ${where}`)
    .get(...params) as { n: number };
  return row.n;
}

export interface ListQuestionsOptions {
  limit?: number;
  scanId?: string;
}

export function listQuestions(
  db: Database.Database,
  opts: ListQuestionsOptions = {},
): QuestionRow[] {
  const capped = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  if (opts.scanId) {
    return db.prepare(
      `SELECT id, scan_id, file_id, transaction_id, account_id, kind, prompt, options_json, context_json, created_at
       FROM questions
       WHERE scan_id = ?
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(opts.scanId, capped) as QuestionRow[];
  }
  return db.prepare(
    `SELECT id, scan_id, file_id, transaction_id, account_id, kind, prompt, options_json, context_json, created_at
     FROM questions
     ORDER BY created_at ASC
     LIMIT ?`,
  ).all(capped) as QuestionRow[];
}
