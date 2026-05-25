import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../../db/schema.js";
import { createAccount } from "../../db/queries/account-balance.js";
import { saveMemory, getMemories } from "../../ai/memory.js";
import {
  upsertMerchant,
  findMerchantById,
  listMerchants,
} from "../../db/queries/merchants.js";
import { collectRules } from "./rules.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "expense:shopping", name: "Shopping", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "expense:subscriptions", name: "Subscriptions", type: "expense", parent_id: "expense" });
  return db;
}

describe("collectRules", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("returns an empty list when nothing has been learned", () => {
    expect(collectRules(db)).toEqual([]);
  });

  it("aggregates user memories and merchant defaults with mem:/mch: ids", () => {
    saveMemory(db, "Wife is Corgi.", "general");
    upsertMerchant(db, { canonical_name: "Amazon", default_account_id: "expense:shopping" });
    upsertMerchant(db, { canonical_name: "Starbucks", default_account_id: "expense:food" });
    upsertMerchant(db, { canonical_name: "Spotify", default_account_id: "expense:subscriptions" });

    const rules = collectRules(db);
    expect(rules).toHaveLength(4);
    expect(rules.filter((r) => r.displayId.startsWith("mem:"))).toHaveLength(1);
    expect(rules.filter((r) => r.displayId.startsWith("mch:"))).toHaveLength(3);
    expect(rules.find((r) => r.displayId === "mch:1")?.text).toBe("Amazon → expense:shopping");
    expect(rules.find((r) => r.displayId === "mch:2")?.text).toBe("Spotify → expense:subscriptions");
    expect(rules.find((r) => r.displayId === "mch:3")?.text).toBe("Starbucks → expense:food");
  });

  it("numbers merchants in alphabetical order by canonical_name", () => {
    upsertMerchant(db, { canonical_name: "Zara", default_account_id: "expense:shopping" });
    upsertMerchant(db, { canonical_name: "Amazon", default_account_id: "expense:shopping" });
    upsertMerchant(db, { canonical_name: "Muji", default_account_id: "expense:shopping" });

    const rules = collectRules(db).filter((r) => r.displayId.startsWith("mch:"));
    expect(rules.map((r) => r.text)).toEqual([
      "Amazon → expense:shopping",
      "Muji → expense:shopping",
      "Zara → expense:shopping",
    ]);
  });

  it("skips merchants with no default", () => {
    upsertMerchant(db, { canonical_name: "Starbucks" });
    expect(collectRules(db)).toEqual([]);
  });

  it("forget() on a memory entry deletes that memory only", () => {
    saveMemory(db, "rule one", "general");
    saveMemory(db, "rule two", "preference");
    const memId = getMemories(db)[0].id;
    const entry = collectRules(db).find((r) => r.displayId === `mem:${memId}`)!;

    entry.forget(db);

    const remaining = getMemories(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).not.toBe(entry.text);
  });

  it("forget() on a merchant entry clears the default account only", () => {
    upsertMerchant(db, { canonical_name: "Starbucks", default_account_id: "expense:food" });
    const merchant = listMerchants(db).find((m) => m.canonical_name === "Starbucks")!;
    const entry = collectRules(db).find((r) => r.displayId === "mch:1")!;

    entry.forget(db);

    expect(findMerchantById(db, merchant.id)?.default_account_id).toBeNull();
  });
});
