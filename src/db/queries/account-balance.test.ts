import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import {
  createAccount,
  updateAccountMetadata,
  findAccountById,
  getAccountSubtree,
  ensureStructuralAccount,
  ensureTopLevelRoot,
} from "./account-balance.js";
import { findAccountsByFuzzyName, accountNumberKey, normalizeMaskedAccountNumber } from "./account-match.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

describe("createAccount", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("inserts a top-level type root with parent_id=null", () => {
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    const row = findAccountById(db, "asset");
    expect(row).toBeTruthy();
    expect(row!.parent_id).toBeNull();
  });

  it("inserts a leaf account under an existing parent", () => {
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, {
      id: "asset:kbank-savings-1234",
      name: "KBank Savings ••1234",
      type: "asset",
      parent_id: "asset",
      subtype: "bank",
      bank_name: "kbank",
      account_number_masked: "••1234",
      currency: "THB",
    });
    const row = findAccountById(db, "asset:kbank-savings-1234");
    expect(row).toBeTruthy();
    expect(row!.parent_id).toBe("asset");
    expect(row!.bank_name).toBe("KBANK");
    expect(row!.currency).toBe("THB");
  });

  it("drops a trailing check digit from the stored masked number", () => {
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, {
      id: "asset:scb-savings-7652",
      name: "SCB Savings ••7652",
      type: "asset",
      parent_id: "asset",
      account_number_masked: "••7652-0",
      currency: "THB",
    });
    expect(findAccountById(db, "asset:scb-savings-7652")!.account_number_masked).toBe("••7652");
  });

  it("auto-bootstraps the top-level root when the parent is one of the five types", () => {
    createAccount(db, {
      id: "expense:food",
      name: "Food",
      type: "expense",
      parent_id: "expense",
    });
    expect(findAccountById(db, "expense")).toBeTruthy();
    expect(findAccountById(db, "expense:food")).toBeTruthy();
  });

  it("rejects parent/type mismatch", () => {
    createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
    expect(() =>
      createAccount(db, { id: "expense:misc", name: "Misc", type: "asset", parent_id: "expense" }),
    ).toThrow(/does not match parent/);
  });

  it("rejects id without parent prefix", () => {
    createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
    expect(() =>
      createAccount(db, { id: "groceries", name: "Groceries", type: "expense", parent_id: "expense" }),
    ).toThrow(/must start with parent id/);
  });

  it("rejects missing parent when not auto-bootstrappable", () => {
    expect(() =>
      createAccount(db, { id: "expense:food:nuts", name: "Nuts", type: "expense", parent_id: "expense:food" }),
    ).toThrow(/does not exist/);
  });

  it("throws ACCOUNT_EXISTS on duplicate id", () => {
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, { id: "asset:dup", name: "First", type: "asset", parent_id: "asset" });
    expect(() =>
      createAccount(db, { id: "asset:dup", name: "Second", type: "asset", parent_id: "asset" }),
    ).toThrow(/already exists/);
  });

  it("serializes metadata to JSON", () => {
    createAccount(db, {
      id: "liability:ktc",
      name: "KTC Card",
      type: "liability",
      parent_id: "liability",
      metadata: { points_program: "Forever" },
    });
    const row = findAccountById(db, "liability:ktc")!;
    expect(JSON.parse(row.metadata_json!)).toEqual({ points_program: "Forever" });
  });
});

describe("ensureStructuralAccount + ensureTopLevelRoot", () => {
  it("idempotently creates uncategorized expense + parent", () => {
    const db = freshDb();
    ensureStructuralAccount(db, "expense:uncategorized");
    ensureStructuralAccount(db, "expense:uncategorized");
    expect(findAccountById(db, "expense")).toBeTruthy();
    const row = findAccountById(db, "expense:uncategorized")!;
    expect(row.parent_id).toBe("expense");
    expect(row.name).toBe("Uncategorized");
  });

  it("idempotently creates the five top-level type roots", () => {
    const db = freshDb();
    for (const t of ["asset", "liability", "income", "expense", "equity"] as const) {
      ensureTopLevelRoot(db, t);
      ensureTopLevelRoot(db, t);
      expect(findAccountById(db, t)).toBeTruthy();
    }
  });
});

describe("hierarchy: getAccountSubtree", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
    createAccount(db, { id: "expense:food:groceries", name: "Groceries", type: "expense", parent_id: "expense:food" });
    createAccount(db, { id: "expense:food:dining", name: "Dining", type: "expense", parent_id: "expense:food" });
    createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
    createAccount(db, { id: "asset:cash", name: "Cash", type: "asset", parent_id: "asset" });
  });

  it("returns the subtree rooted at a given id", () => {
    const subtree = getAccountSubtree(db, "expense:food");
    const ids = subtree.map(r => r.id).sort();
    expect(ids).toEqual([
      "expense:food",
      "expense:food:dining",
      "expense:food:groceries",
    ]);
  });
});

describe("updateAccountMetadata", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    createAccount(db, {
      id: "liability:ktc",
      name: "KTC Card",
      type: "liability",
      parent_id: "liability",
      bank_name: "ktc",
      due_day: 15,
    });
  });

  it("returns before/after for changed fields", () => {
    const result = updateAccountMetadata(db, "liability:ktc", { due_day: 20, statement_day: 28 });
    expect(result.changed).toBe(true);
    expect(result.before.due_day).toBe(15);
    expect(result.after.due_day).toBe(20);
    expect(result.before.statement_day).toBeNull();
    expect(result.after.statement_day).toBe(28);
  });

  it("reports no change when patch is empty", () => {
    const result = updateAccountMetadata(db, "liability:ktc", {});
    expect(result.changed).toBe(false);
  });

  it("shallow-merges metadata into the existing blob", () => {
    updateAccountMetadata(db, "liability:ktc", { metadata: { points_program: "Forever" } });
    updateAccountMetadata(db, "liability:ktc", { metadata: { points_balance: 1200 } });
    const row = findAccountById(db, "liability:ktc")!;
    expect(JSON.parse(row.metadata_json!)).toEqual({
      points_program: "Forever",
      points_balance: 1200,
    });
  });

  it("throws on unknown account", () => {
    expect(() => updateAccountMetadata(db, "asset:nope", { due_day: 1 })).toThrow(/not found/);
  });
});

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
