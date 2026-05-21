import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../../db/schema.js";
import { accountIngestTools, resolveIngestTools } from "./ingest.js";
import { createAccount, findAccountById } from "../../db/queries/account-balance.js";
import { listActions } from "../../db/queries/action-log.js";
import { recordUnknown, listOpenUnknowns } from "../../db/queries/unknowns.js";
import type { AgentExecutionContext } from "./types.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "liability", name: "Liabilities", type: "liability", parent_id: null });
  createAccount(db, { id: "income", name: "Income", type: "income", parent_id: null });
  createAccount(db, { id: "asset:kbank", name: "KBank Savings", type: "asset", parent_id: "asset", subtype: "bank", bank_name: "kbank" });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense", subtype: "groceries" });
  return db;
}

function ctx(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return { interactive: false, ...overrides };
}

describe("accountIngestTools — record-context action_log", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("create_account writes a row when correlationId is set", async () => {
    const res = await accountIngestTools.execute(db, "create_account", {
      id: "income:salary",
      name: "Salary",
      type: "income",
      parent_id: "income",
    }, ctx({ command: "record", correlationId: "cr:1", userInput: "got salary" }));
    expect(res).toMatch(/Account created/);
    const rows = listActions(db, { correlationId: "cr:1" });
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe("create_account");
    expect(rows[0].target_id).toBe("income:salary");
    const payload = JSON.parse(rows[0].payload_json);
    expect(payload.row.id).toBe("income:salary");
    expect(payload.row.name).toBe("Salary");
    expect(payload.row.type).toBe("income");
  });

  it("create_account writes no row without correlationId", async () => {
    await accountIngestTools.execute(db, "create_account", {
      id: "income:salary",
      name: "Salary",
      type: "income",
      parent_id: "income",
    }, ctx());
    expect(listActions(db)).toHaveLength(0);
    expect(findAccountById(db, "income:salary")).toBeTruthy();
  });

  it("update_account_metadata writes before/after for touched fields only", async () => {
    createAccount(db, { id: "liability:ktc", name: "KTC", type: "liability", parent_id: "liability", due_day: 15 });
    await accountIngestTools.execute(db, "update_account_metadata", {
      account_id: "liability:ktc",
      due_day: 20,
      statement_day: 28,
    }, ctx({ command: "record", correlationId: "cr:meta" }));
    const rows = listActions(db, { correlationId: "cr:meta" });
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe("update_account_metadata");
    const payload = JSON.parse(rows[0].payload_json);
    expect(payload.before).toEqual({ due_day: 15, statement_day: null });
    expect(payload.after).toEqual({ due_day: 20, statement_day: 28 });
  });

  it("update_account_metadata with an empty patch writes no row", async () => {
    await accountIngestTools.execute(db, "update_account_metadata", {
      account_id: "asset:kbank",
    }, ctx({ command: "record", correlationId: "cr:noop" }));
    expect(listActions(db, { correlationId: "cr:noop" })).toHaveLength(0);
  });

  it("record_transaction writes a record_transaction row with full postings", async () => {
    await accountIngestTools.execute(db, "record_transaction", {
      date: "2026-05-19",
      description: "Coffee",
      postings: [
        { account_id: "expense:food", debit: 100 },
        { account_id: "asset:kbank", credit: 100 },
      ],
    }, ctx({ command: "record", correlationId: "cr:tx", userInput: "coffee 100" }));
    const rows = listActions(db, { correlationId: "cr:tx" });
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe("record_transaction");
    expect(rows[0].target_id).toMatch(/^tx:/);
    const payload = JSON.parse(rows[0].payload_json);
    expect(payload.transaction.date).toBe("2026-05-19");
    expect(payload.transaction.description).toBe("Coffee");
    expect(payload.postings).toHaveLength(2);
    expect(payload.postings[0].debit).toBe(100);
    expect(payload.postings[1].credit).toBe(100);
  });

  it("record_transaction with embedded merchant upserts merchant atomically", async () => {
    await accountIngestTools.execute(db, "record_transaction", {
      date: "2026-05-19",
      description: "Coffee at Starbucks",
      raw_descriptor: "STARBUCKS #1234 BKK",
      merchant: { canonical_name: "Starbucks", alias: "STARBUCKS #1234 BKK", default_account_id: "expense:food" },
      postings: [
        { account_id: "expense:food", debit: 120 },
        { account_id: "asset:kbank", credit: 120 },
      ],
    }, ctx({ command: "record", correlationId: "cr:merch" }));
    const merchant = db.prepare(`SELECT id, canonical_name, default_account_id FROM merchants`).get() as { id: string; canonical_name: string; default_account_id: string };
    expect(merchant.canonical_name).toBe("Starbucks");
    expect(merchant.default_account_id).toBe("expense:food");
    const tx = db.prepare(`SELECT merchant_id, raw_descriptor FROM transactions`).get() as { merchant_id: string; raw_descriptor: string };
    expect(tx.merchant_id).toBe(merchant.id);
    expect(tx.raw_descriptor).toBe("STARBUCKS #1234 BKK");
  });

  it("record_transaction writes no row without correlationId", async () => {
    await accountIngestTools.execute(db, "record_transaction", {
      date: "2026-05-19",
      description: "Coffee",
      postings: [
        { account_id: "expense:food", debit: 100 },
        { account_id: "asset:kbank", credit: 100 },
      ],
    }, ctx());
    expect(listActions(db)).toHaveLength(0);
  });

  it("create_account rejects parent/type mismatch", async () => {
    const res = await accountIngestTools.execute(db, "create_account", {
      id: "expense:cash",
      name: "Cash (wrong type)",
      type: "asset",
      parent_id: "expense",
    }, ctx());
    expect(res).toMatch(/does not match parent/);
  });

  it("update_account_metadata writes no audit row when the patch has no fields", async () => {
    const cr = "cr:noop";
    const res = await accountIngestTools.execute(db, "update_account_metadata", {
      account_id: "asset:kbank",
    }, ctx({ command: "record", correlationId: cr }));
    expect(res).toBe("Nothing to update.");
    expect(listActions(db, { correlationId: cr })).toHaveLength(0);
  });

  it("groups three writes under one correlation_id", async () => {
    const cr = "cr:group";
    await accountIngestTools.execute(db, "create_account", {
      id: "income:salary",
      name: "Salary",
      type: "income",
      parent_id: "income",
    }, ctx({ command: "record", correlationId: cr }));
    await accountIngestTools.execute(db, "record_transaction", {
      date: "2026-05-19",
      description: "Salary received",
      postings: [
        { account_id: "asset:kbank", debit: 60000 },
        { account_id: "income:salary", credit: 60000 },
      ],
    }, ctx({ command: "record", correlationId: cr }));
    await accountIngestTools.execute(db, "update_account_metadata", {
      account_id: "asset:kbank",
      account_number_masked: "••1234",
    }, ctx({ command: "record", correlationId: cr }));

    const rows = listActions(db, { correlationId: cr });
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.action_type)).toEqual([
      "create_account",
      "record_transaction",
      "update_account_metadata",
    ]);
  });
});

describe("resolveIngestTools — close_unknown", () => {
  it("closes a primary unknown plus all related siblings in one call", async () => {
    const db = freshDb();
    const ids = [0, 1, 2].map(i =>
      recordUnknown(db, {
        file_id: null,
        transaction_id: null,
        account_id: "expense:food",
        kind: "uncategorized_expense",
        prompt: `Lazada row ${i}`,
        options: ["expense:shopping", "Skip — leave as is"],
      }),
    );

    const res = await resolveIngestTools.execute(db, "close_unknown", {
      unknown_id: ids[0],
      answer: "expense:shopping",
      related_unknown_ids: [ids[1], ids[2]],
    }, ctx());

    expect(res).toBe("Resolved 3 unknowns with: expense:shopping");
    expect(listOpenUnknowns(db)).toHaveLength(0);
  });

  it("returns a helpful error when unknown_id is unknown", async () => {
    const db = freshDb();
    const res = await resolveIngestTools.execute(db, "close_unknown", {
      unknown_id: "cn:nope",
      answer: "Skip — leave as is",
    }, ctx());
    expect(res).toMatch(/not found/);
  });
});
