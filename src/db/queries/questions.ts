import type Database from "libsql";
import { randomUUID } from "crypto";

export interface QuestionTarget {
  /** The transfer this question is about, when it targets a specific movement. */
  transfer_id?: string | null;
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
  transfer_id: string | null;
  account_id: string | null;
  kind: string | null;
  prompt: string;
  options_json: string | null;
  context_json: string | null;
  deferred_until: string | null;
  created_at: string;
}

export interface ClosedQuestion {
  prompt: string;
  kind: string | null;
  answer: string;
  /** Stable signature pulled from the question's context_json. When set, the
   * rule synthesizer keys the learned rule on this (so future questions with
   * different prose but the same key match). When null, no rule is learned. */
  rule_key: string | null;
}

/**
 * Insert a new questions row and flip the `has_question` boolean on whichever
 * target (transfer / account) was named. Returns the new id. The id keeps
 * the historical `cn:` prefix: it's opaque and nothing else references it,
 * so the prefix is a no-op detail.
 */
export function recordQuestion(db: Database.Database, input: RecordQuestionInput): string {
  const id = `cn:${randomUUID()}`;
  db.prepare(
    `INSERT INTO questions (id, scan_id, file_id, transfer_id, account_id, kind, prompt, options_json, context_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.scan_id ?? null,
    input.file_id,
    input.transfer_id ?? null,
    input.account_id,
    input.kind ?? null,
    input.prompt,
    input.options ? JSON.stringify(input.options) : null,
    input.context ? JSON.stringify(input.context) : null,
  );
  if (input.transfer_id) {
    db.prepare(`UPDATE transfers SET has_question = 1 WHERE id = ?`).run(input.transfer_id);
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
      `SELECT prompt, kind, transfer_id, account_id, context_json FROM questions WHERE id = ?`,
    )
    .get(id) as
    | {
        prompt: string;
        kind: string | null;
        transfer_id: string | null;
        account_id: string | null;
        context_json: string | null;
      }
    | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM questions WHERE id = ?`).run(id);
  maybeClearHasQuestionFlags(db, {
    transfer_id: row.transfer_id,
    account_id: row.account_id,
  });
  return {
    prompt: row.prompt,
    kind: row.kind,
    answer,
    rule_key: extractRuleKey(row.context_json),
  };
}

function extractRuleKey(contextJson: string | null): string | null {
  if (!contextJson) return null;
  try {
    const parsed = JSON.parse(contextJson);
    return typeof parsed?.rule_key === "string" ? parsed.rule_key : null;
  } catch {
    return null;
  }
}

/**
 * Look up the transfer/account a question is attached to. Returns null when
 * the question id doesn't exist.
 */
export function getQuestionTarget(db: Database.Database, id: string): QuestionTarget | null {
  const row = db
    .prepare(`SELECT transfer_id, account_id FROM questions WHERE id = ?`)
    .get(id) as QuestionTarget | undefined;
  return row ?? null;
}

/**
 * Clear `has_question` on the named transfer / account if no other
 * questions still reference it. Safe to call after any resolution; idempotent.
 */
function maybeClearHasQuestionFlags(db: Database.Database, target: QuestionTarget): void {
  if (target.transfer_id) {
    const open = db
      .prepare(`SELECT 1 FROM questions WHERE transfer_id = ? LIMIT 1`)
      .get(target.transfer_id);
    if (!open) db.prepare(`UPDATE transfers SET has_question = 0 WHERE id = ?`).run(target.transfer_id);
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
  transfer_id?: string;
  account_id?: string;
  kind?: string;
  scan_id?: string;
  /** When true, count deferred rows too (default false: defer hides). */
  includeDeferred?: boolean;
}

const ACTIVE_DEFERRED_CLAUSE =
  "(deferred_until IS NULL OR deferred_until <= datetime('now'))";

export function countQuestions(db: Database.Database, scope: CountQuestionsScope = {}): number {
  const conditions: string[] = [];
  const params: any[] = [];
  if (scope.file_id)     { conditions.push("file_id = ?");     params.push(scope.file_id); }
  if (scope.transfer_id) { conditions.push("transfer_id = ?"); params.push(scope.transfer_id); }
  if (scope.account_id)  { conditions.push("account_id = ?");  params.push(scope.account_id); }
  if (scope.kind)           { conditions.push("kind = ?");           params.push(scope.kind); }
  if (scope.scan_id)        { conditions.push("scan_id = ?");        params.push(scope.scan_id); }
  if (!scope.includeDeferred) conditions.push(ACTIVE_DEFERRED_CLAUSE);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM questions ${where}`)
    .get(...params) as { n: number };
  return row.n;
}

export interface ListQuestionsOptions {
  limit?: number;
  scanId?: string;
  /** Filter by the question's free-text `kind` column. */
  kind?: string;
  /** Filter by the `scanned_files` id the question is attached to. */
  fileId?: string;
  /** When true, include deferred rows in the result (default false). */
  includeDeferred?: boolean;
}

const ROW_COLUMNS =
  "id, scan_id, file_id, transfer_id, account_id, kind, prompt, options_json, context_json, deferred_until, created_at";

export function listQuestions(
  db: Database.Database,
  opts: ListQuestionsOptions = {},
): QuestionRow[] {
  const capped = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const conditions: string[] = [];
  const params: any[] = [];
  if (opts.scanId) { conditions.push("scan_id = ?"); params.push(opts.scanId); }
  if (opts.kind)   { conditions.push("kind = ?");    params.push(opts.kind); }
  if (opts.fileId) { conditions.push("file_id = ?"); params.push(opts.fileId); }
  if (!opts.includeDeferred) conditions.push(ACTIVE_DEFERRED_CLAUSE);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(capped);
  return db.prepare(
    `SELECT ${ROW_COLUMNS}
     FROM questions
     ${where}
     ORDER BY created_at ASC
     LIMIT ?`,
  ).all(...params) as QuestionRow[];
}

/**
 * Mark a question as deferred for `days` days from now. The default
 * `listQuestions` / `countQuestions` filter hides deferred rows until the
 * timestamp passes, so the clarifier won't re-encounter the question on the
 * next run. Pass `includeDeferred: true` to those functions for an
 * unfiltered view (e.g. for the rules / files browsers).
 */
export function deferQuestion(
  db: Database.Database,
  id: string,
  days: number,
): boolean {
  const safeDays = Math.max(1, Math.floor(days));
  const result = db
    .prepare(`UPDATE questions SET deferred_until = datetime('now', ?) WHERE id = ?`)
    .run(`+${safeDays} days`, id);
  return result.changes > 0;
}
