import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import {
  upsertMerchant,
  findMerchantByAlias,
  findMerchantById,
  listMerchants,
  setMerchantDefaultAccount,
  normalizeDescriptor,
} from "./merchants.js";
import { createAccount } from "./account_balance.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "expense:food:dining", name: "Dining", type: "expense", parent_id: "expense:food" });
  return db;
}

describe("normalizeDescriptor", () => {
  it("strips trailing #1234-style store ids", () => {
    expect(normalizeDescriptor("STARBUCKS #1234")).toBe("starbucks");
    expect(normalizeDescriptor("Starbucks #5678 BANGKOK")).toBe("starbucks");
  });

  it("strips common location and transaction tokens", () => {
    expect(normalizeDescriptor("AMAZON WEB CHARGE")).toBe("amazon");
    expect(normalizeDescriptor("LAZADA TH POS PAYMENT")).toBe("lazada");
  });

  it("collapses whitespace and lowercases", () => {
    expect(normalizeDescriptor("  HOME   DEPOT  ")).toBe("home depot");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeDescriptor("")).toBe("");
    expect(normalizeDescriptor("  ")).toBe("");
  });
});

describe("upsertMerchant", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("inserts a new merchant the first time", () => {
    const m = upsertMerchant(db, { canonical_name: "Starbucks" });
    expect(m.id).toMatch(/^m:/);
    expect(m.canonical_name).toBe("Starbucks");
    expect(m.default_account_id).toBeNull();
  });

  it("returns the same merchant on second upsert by canonical_name", () => {
    const a = upsertMerchant(db, { canonical_name: "Starbucks" });
    const b = upsertMerchant(db, { canonical_name: "Starbucks" });
    expect(b.id).toBe(a.id);
  });

  it("updates default_account_id on subsequent upsert", () => {
    upsertMerchant(db, { canonical_name: "Starbucks" });
    const updated = upsertMerchant(db, {
      canonical_name: "Starbucks",
      default_account_id: "expense:food:dining",
    });
    expect(updated.default_account_id).toBe("expense:food:dining");
  });

  it("inserts an alias when provided, deduped on normalized_pattern", () => {
    upsertMerchant(db, { canonical_name: "Starbucks", alias: "STARBUCKS #1234" });
    upsertMerchant(db, { canonical_name: "Starbucks", alias: "STARBUCKS #5678" });
    const aliases = db.prepare(`SELECT normalized_pattern FROM merchant_aliases`).all() as { normalized_pattern: string }[];
    expect(aliases.map(a => a.normalized_pattern).sort()).toEqual(["starbucks"]);
  });
});

describe("findMerchantByAlias", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    upsertMerchant(db, {
      canonical_name: "Starbucks",
      alias: "STARBUCKS #1234 BANGKOK",
      default_account_id: "expense:food:dining",
    });
  });

  it("finds the merchant by an exact-match raw descriptor", () => {
    const hit = findMerchantByAlias(db, "STARBUCKS #1234 BANGKOK");
    expect(hit).toBeTruthy();
    expect(hit!.merchant.canonical_name).toBe("Starbucks");
    expect(hit!.default_account_id).toBe("expense:food:dining");
  });

  it("finds the merchant by a normalized-equivalent descriptor", () => {
    const hit = findMerchantByAlias(db, "Starbucks #9999 BKK CHARGE");
    expect(hit).toBeTruthy();
    expect(hit!.merchant.canonical_name).toBe("Starbucks");
  });

  it("returns null when no alias matches", () => {
    expect(findMerchantByAlias(db, "Some Random Store")).toBeNull();
  });
});

describe("setMerchantDefaultAccount + listMerchants + findMerchantById", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    upsertMerchant(db, { canonical_name: "Starbucks" });
    upsertMerchant(db, { canonical_name: "Amazon", default_account_id: "expense:food" });
  });

  it("returns before/after when updating the default", () => {
    const m = upsertMerchant(db, { canonical_name: "Starbucks" });
    const result = setMerchantDefaultAccount(db, m.id, "expense:food:dining");
    expect(result.before).toBeNull();
    expect(result.after).toBe("expense:food:dining");
    expect(findMerchantById(db, m.id)!.default_account_id).toBe("expense:food:dining");
  });

  it("lists merchants with alias counts", () => {
    const m = upsertMerchant(db, { canonical_name: "Starbucks" });
    upsertMerchant(db, { canonical_name: "Starbucks", alias: "starbucks #1" });
    upsertMerchant(db, { canonical_name: "Starbucks", alias: "starbucks #2" });
    const rows = listMerchants(db);
    expect(rows.length).toBeGreaterThan(0);
    const sbux = rows.find(r => r.id === m.id)!;
    expect(sbux.alias_count).toBe(1); // both aliases normalize to "starbucks" — single row
  });
});
