import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import { createAccount } from "./account-balance.js";
import { recordUnknown, listOpenUnknowns, listOpenUnknownsByKind, resolveUnknown } from "./unknowns.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  return db;
}

describe("listOpenUnknownsByKind", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    recordUnknown(db, { file_id: null, transaction_id: null, account_id: "expense:food", kind: "duplicate",            prompt: "dup",   options: ["keep","drop"] });
    recordUnknown(db, { file_id: null, transaction_id: null, account_id: "expense:food", kind: "uncategorized",        prompt: "uncat", options: ["a","b"] });
    recordUnknown(db, { file_id: null, transaction_id: null, account_id: "expense:food", kind: "recurrence_candidate", prompt: "rec",   options: ["link","skip"] });
    recordUnknown(db, { file_id: null, transaction_id: null, account_id: "expense:food", kind: "correlation",          prompt: "corr",  options: ["merge","split"] });
  });

  it("returns only unknowns whose kind is in the filter", () => {
    const rows = listOpenUnknownsByKind(db, ["duplicate", "correlation"]);
    expect(rows.map(r => r.kind)).toEqual(expect.arrayContaining(["duplicate", "correlation"]));
    expect(rows.find(r => r.kind === "uncategorized")).toBeUndefined();
  });

  it("orders rows by the input kind priority, then created_at", () => {
    const rows = listOpenUnknownsByKind(db, ["uncategorized", "duplicate", "correlation", "recurrence_candidate"]);
    expect(rows.map(r => r.kind)).toEqual(["uncategorized", "duplicate", "correlation", "recurrence_candidate"]);
  });

  it("excludes resolved unknowns", () => {
    const dup = listOpenUnknownsByKind(db, ["duplicate"])[0];
    resolveUnknown(db, dup.id, "drop");
    expect(listOpenUnknownsByKind(db, ["duplicate"])).toEqual([]);
  });

  it("returns empty when no kinds requested", () => {
    expect(listOpenUnknownsByKind(db, [])).toEqual([]);
  });
});

describe("unknowns.kind is free-text", () => {
  it("accepts the canonical built-in kinds plus arbitrary plugin values", () => {
    const db = freshDb();
    const kinds = ["uncategorized", "duplicate", "correlation", "recurrence_candidate", "similar_accounts", "file_password", "acme.tax_th__refund"];
    for (const k of kinds) {
      expect(() => recordUnknown(db, { file_id: null, transaction_id: null, account_id: "expense:food", kind: k, prompt: k })).not.toThrow();
    }
    expect(listOpenUnknowns(db, 100)).toHaveLength(kinds.length);
  });
});
