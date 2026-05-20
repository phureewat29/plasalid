import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import { appendAction, listActions } from "./action-log.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

describe("action_log", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("round-trips an action and parses the payload back", () => {
    const id = appendAction(db, {
      correlation_id: "cr:1",
      command: "record",
      user_input: "buy coffee 100 thb",
      action_type: "record_transaction",
      target_id: "tx:abc",
      payload: {
        transaction: { date: "2026-05-19" },
        postings: [{ account_id: "expense:food", debit: 100 }],
      },
    });
    expect(id).toMatch(/^al:/);
    const rows = listActions(db);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(id);
    expect(row.command).toBe("record");
    expect(row.action_type).toBe("record_transaction");
    expect(row.target_id).toBe("tx:abc");
    expect(JSON.parse(row.payload_json)).toEqual({
      transaction: { date: "2026-05-19" },
      postings: [{ account_id: "expense:food", debit: 100 }],
    });
  });

  it("filters by correlation_id and command", () => {
    appendAction(db, {
      correlation_id: "cr:a",
      command: "record",
      action_type: "create_account",
      target_id: "asset:1",
      payload: {},
    });
    appendAction(db, {
      correlation_id: "cr:a",
      command: "record",
      action_type: "record_transaction",
      target_id: "tx:1",
      payload: {},
    });
    appendAction(db, {
      correlation_id: "cr:b",
      command: "record",
      action_type: "record_transaction",
      target_id: "tx:2",
      payload: {},
    });

    expect(listActions(db)).toHaveLength(3);
    expect(listActions(db, { correlationId: "cr:a" })).toHaveLength(2);
    expect(listActions(db, { correlationId: "cr:b" })).toHaveLength(1);
    expect(listActions(db, { command: "record" })).toHaveLength(3);
    expect(listActions(db, { command: "scan" })).toHaveLength(0);
  });

  it("preserves chronological order", () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        appendAction(db, {
          correlation_id: "cr:seq",
          command: "record",
          action_type: "record_transaction",
          target_id: `tx:${i}`,
          payload: { i },
        }),
      );
    }
    const rows = listActions(db, { correlationId: "cr:seq" });
    expect(rows.map((r) => r.id)).toEqual(ids);
  });

  it("accepts merchant action types", () => {
    const id = appendAction(db, {
      correlation_id: "cr:m",
      command: "record",
      action_type: "create_merchant",
      target_id: "m:starbucks",
      payload: {
        canonical_name: "Starbucks",
        default_account_id: "expense:food:dining",
      },
    });
    expect(id).toMatch(/^al:/);
    appendAction(db, {
      correlation_id: "cr:m",
      command: "resolve",
      action_type: "update_merchant_default",
      target_id: "m:starbucks",
      payload: { before: null, after: "expense:food:dining" },
    });
    const rows = listActions(db, { correlationId: "cr:m" });
    expect(rows.map((r) => r.action_type)).toEqual([
      "create_merchant",
      "update_merchant_default",
    ]);
  });
});
