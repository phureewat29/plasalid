import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { createAccount, findAccountById } from "./accounts.js";
import { resolveOnePosting } from "./resolve.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "asset:cash", name: "Cash", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  return db;
}

describe("resolveOnePosting", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("exact match: existing account, no hint", () => {
    const { posting, hint } = resolveOnePosting(db, { account_id: "expense:food" });
    expect(posting.account_id).toBe("expense:food");
    expect(hint).toBeNull();
  });

  it("well-formed multi-segment hint: auto-creates the path, placeholder_created (no fallback)", () => {
    const { posting, hint } = resolveOnePosting(db, { account_id: "expense:food:dining" });
    expect(posting.account_id).toBe("expense:food:dining");
    expect(hint).toEqual({ type: "placeholder_created", accountId: "expense:food:dining" });
    expect(findAccountById(db, "expense:food:dining")).toBeTruthy();
  });

  it("well-formed two-segment hint under a fresh top-level type: placeholder_created", () => {
    const { posting, hint } = resolveOnePosting(db, { account_id: "equity:opening-balance" });
    expect(posting.account_id).toBe("equity:opening-balance");
    expect(hint).toEqual({ type: "placeholder_created", accountId: "equity:opening-balance" });
    expect(findAccountById(db, "equity")).toBeTruthy();
    expect(findAccountById(db, "equity:opening-balance")).toBeTruthy();
  });

  it("leaf-only hint: falls back to expense:uncategorized (uncategorized_fallback)", () => {
    const { posting, hint } = resolveOnePosting(db, { account_id: "dining" });
    expect(posting.account_id).toBe("expense:uncategorized");
    expect(hint).toEqual({ type: "uncategorized_fallback", accountId: "expense:uncategorized" });
    expect(findAccountById(db, "dining")).toBeNull();
  });

  it("type-invalid hint (unknown top-level segment): uncategorized_fallback", () => {
    /**
     * Leaf "organic" is far enough from every seeded name to miss fuzzy match, so resolution
     * reaches the placeholder stage — where "groceries" is not a known top-level type, so it falls back.
     */
    const { posting, hint } = resolveOnePosting(db, { account_id: "groceries:organic" });
    expect(posting.account_id).toBe("expense:uncategorized");
    expect(hint).toEqual({ type: "uncategorized_fallback", accountId: "expense:uncategorized" });
    expect(findAccountById(db, "groceries:organic")).toBeNull();
  });

  it("ancestor-type-mismatch during the walk: uncategorized_fallback", () => {
    /**
     * Insert an ancestor whose type contradicts its colon-path prefix (bypassing
     * createAccount's invariants), so the chain walk hits createAccount's parent-type
     * mismatch, which resolution swallows into the uncategorized fallback.
     */
    db.prepare(
      `INSERT INTO accounts (id, name, type, parent_id) VALUES ('expense:weird', 'Weird', 'asset', 'expense')`,
    ).run();

    const { posting, hint } = resolveOnePosting(db, { account_id: "expense:weird:child" });
    expect(posting.account_id).toBe("expense:uncategorized");
    expect(hint).toEqual({ type: "uncategorized_fallback", accountId: "expense:uncategorized" });
    expect(findAccountById(db, "expense:weird:child")).toBeNull();
  });
});
