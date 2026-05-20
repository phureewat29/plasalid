import type Database from "libsql";
import { randomUUID } from "crypto";

export type ActionCommand = "record" | "scan" | "resolve";

export type ActionType =
  | "create_account"
  | "update_account_metadata"
  | "record_transaction"
  | "adjust_balance"
  | "create_merchant"
  | "update_merchant_default";

export interface ActionLogInput {
  correlation_id: string;
  command: ActionCommand;
  user_input?: string | null;
  action_type: ActionType;
  target_id: string;
  payload: Record<string, unknown>;
}

export interface ActionLogRow {
  id: string;
  correlation_id: string;
  command: ActionCommand;
  user_input: string | null;
  action_type: ActionType;
  target_id: string;
  payload_json: string;
  created_at: string;
  reverted_at: string | null;
}

export function appendAction(db: Database.Database, input: ActionLogInput): string {
  const id = `al:${randomUUID()}`;
  db.prepare(
    `INSERT INTO action_log
       (id, correlation_id, command, user_input, action_type, target_id, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.correlation_id,
    input.command,
    input.user_input ?? null,
    input.action_type,
    input.target_id,
    JSON.stringify(input.payload),
  );
  return id;
}

export interface ListActionsOptions {
  limit?: number;
  command?: ActionCommand;
  correlationId?: string;
}

export function listActions(
  db: Database.Database,
  opts: ListActionsOptions = {},
): ActionLogRow[] {
  const conds: string[] = [];
  const params: any[] = [];
  if (opts.command) {
    conds.push("command = ?");
    params.push(opts.command);
  }
  if (opts.correlationId) {
    conds.push("correlation_id = ?");
    params.push(opts.correlationId);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  return db
    .prepare(
      `SELECT id, correlation_id, command, user_input, action_type, target_id,
              payload_json, created_at, reverted_at
       FROM action_log ${where} ORDER BY rowid ASC LIMIT ?`,
    )
    .all(...params, limit) as ActionLogRow[];
}
