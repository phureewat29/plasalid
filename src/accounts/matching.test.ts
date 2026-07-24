import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { createAccount, findAccountById } from "./accounts.js";
import { findAccountsByFuzzyName, accountNumberKey, normalizeMaskedAccountNumber } from "./matching.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

describe("findAccountsByFuzzyName", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    createAccount(db, { id: "asset:ttb-1", name: "TTB Savings ••1234", type: "asset", parent_id: "asset" });
    createAccount(db, { id: "asset:scb-1", name: "SCB Savings ••5678", type: "asset", parent_id: "asset" });
    createAccount(db, { id: "asset:kbank-1", name: "KBank Savings ••9012", type: "asset", parent_id: "asset" });
  });

  it("finds the right account by substring", () => {
    const matches = findAccountsByFuzzyName(db, "ttb saving");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].account.id).toBe("asset:ttb-1");
    expect(matches[0].similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("returns multiple candidates ranked by similarity", () => {
    const matches = findAccountsByFuzzyName(db, "saving");
    const ids = matches.map(m => m.account.id);
    expect(ids).toContain("asset:ttb-1");
    expect(ids).toContain("asset:scb-1");
    expect(ids).toContain("asset:kbank-1");
  });

  it("respects the threshold", () => {
    const matches = findAccountsByFuzzyName(db, "xyz", 0.9);
    expect(matches).toHaveLength(0);
  });

  it("returns nothing for empty query", () => {
    expect(findAccountsByFuzzyName(db, "")).toEqual([]);
    expect(findAccountsByFuzzyName(db, "   ")).toEqual([]);
  });

  it("matches a number with a trailing check digit against the masked number", () => {
    createAccount(db, {
      id: "asset:kbank-7652",
      name: "KBank Savings ••7652",
      type: "asset",
      parent_id: "asset",
      account_number_masked: "••7652",
    });
    const matches = findAccountsByFuzzyName(db, "kbank savings 76520");
    expect(matches[0].account.id).toBe("asset:kbank-7652");
    expect(matches[0].similarity).toBeGreaterThanOrEqual(0.9);
  });
});

describe("accountNumberKey", () => {
  it("strips separators and a trailing check digit to the last 4 digits", () => {
    expect(accountNumberKey("••7652")).toBe("7652");
    expect(accountNumberKey("••7652-0")).toBe("7652");
    expect(accountNumberKey("xxx-7652-0")).toBe("7652");
    expect(accountNumberKey("1234")).toBe("1234");
    expect(accountNumberKey(null)).toBe("");
    expect(accountNumberKey("••")).toBe("");
  });

  it("uses the literal trailing digits after a mask run, without dropping one as a check digit", () => {
    /**
     * Regression: digits before the mask used to get concatenated with the
     * trailing digits, and the check-digit heuristic dropped a real trailing
     * digit ("470686XXXXXX9483" -> "6948" instead of "9483").
     */
    expect(accountNumberKey("470686XXXXXX9483")).toBe("9483");
    expect(accountNumberKey("470686XXXXXX483")).toBe("483");
    // A pure-digit number (no mask chars) keeps the check-digit-drop heuristic: "76520" -> "7652".
    expect(accountNumberKey("76520")).toBe("7652");
  });
});

describe("normalizeMaskedAccountNumber", () => {
  it("collapses check-digit variants to one masked value", () => {
    expect(normalizeMaskedAccountNumber("••7652-0")).toBe("••7652");
    expect(normalizeMaskedAccountNumber("••76520")).toBe("••7652");
    expect(normalizeMaskedAccountNumber("••7652")).toBe("••7652");
    expect(normalizeMaskedAccountNumber(null)).toBeNull();
    expect(normalizeMaskedAccountNumber("••")).toBe("••");
  });

  it("stores the literal trailing digits (ending in 9483) for a masked-middle number", () => {
    const normalized = normalizeMaskedAccountNumber("470686XXXXXX9483");
    expect(normalized).not.toBeNull();
    expect(normalized!.endsWith("9483")).toBe(true);
  });
});

describe("createAccount with a masked-middle account number", () => {
  it("stores a display mask ending in the real trailing digits, not a corrupted check-digit drop", () => {
    const db = freshDb();
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, {
      id: "asset:kbank-9483",
      name: "KBank Savings",
      type: "asset",
      parent_id: "asset",
      account_number_masked: "470686XXXXXX9483",
    });
    const stored = findAccountById(db, "asset:kbank-9483")!.account_number_masked!;
    expect(stored.endsWith("9483")).toBe(true);
  });
});

describe("findAccountsByFuzzyName matching key derivation for a masked-middle query", () => {
  it("matches on the literal trailing digits, not the longer unmasked prefix run", () => {
    const db = freshDb();
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, {
      id: "asset:kbank-9483",
      name: "KBank Savings",
      type: "asset",
      parent_id: "asset",
      account_number_masked: "••9483",
    });
    const matches = findAccountsByFuzzyName(db, "470686XXXXXX9483");
    expect(matches[0]?.account.id).toBe("asset:kbank-9483");
  });
});
