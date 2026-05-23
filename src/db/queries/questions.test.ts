import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import { createAccount } from "./account-balance.js";
import { recordQuestion, listQuestions, closeQuestion, countQuestions } from "./questions.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  return db;
}

describe("questions table", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("accepts arbitrary free-text kinds", () => {
    const kinds = ["uncategorized", "duplicate", "correlation", "recurrence_candidate", "similar_accounts", "file_password", "acme.tax_th__refund"];
    for (const k of kinds) {
      expect(() => recordQuestion(db, { file_id: null, transaction_id: null, account_id: "expense:food", kind: k, prompt: k })).not.toThrow();
    }
    expect(listQuestions(db, { limit: 100 })).toHaveLength(kinds.length);
  });

  it("closeQuestion deletes the row and returns the captured tuple", () => {
    recordQuestion(db, { file_id: null, transaction_id: null, account_id: "expense:food", kind: "uncategorized", prompt: "Which category?" });
    const open = listQuestions(db);
    expect(open).toHaveLength(1);
    const closed = closeQuestion(db, open[0].id, "expense:food:groceries");
    expect(closed).toEqual({ prompt: "Which category?", kind: "uncategorized", answer: "expense:food:groceries" });
    expect(listQuestions(db)).toHaveLength(0);
    expect(countQuestions(db)).toBe(0);
  });

  it("listQuestions scopes by scanId when supplied", () => {
    recordQuestion(db, { file_id: null, scan_id: "sc:a", transaction_id: null, account_id: "expense:food", kind: "uncategorized", prompt: "a" });
    recordQuestion(db, { file_id: null, scan_id: "sc:b", transaction_id: null, account_id: "expense:food", kind: "uncategorized", prompt: "b" });
    recordQuestion(db, { file_id: null, scan_id: null, transaction_id: null, account_id: "expense:food", kind: "uncategorized", prompt: "c" });
    expect(listQuestions(db, { scanId: "sc:a" }).map(r => r.prompt)).toEqual(["a"]);
    expect(listQuestions(db, { scanId: "sc:b" }).map(r => r.prompt)).toEqual(["b"]);
    expect(listQuestions(db).map(r => r.prompt).sort()).toEqual(["a", "b", "c"]);
  });
});
