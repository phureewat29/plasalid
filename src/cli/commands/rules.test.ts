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
import { renderRules, forgetRules } from "./rules.js";

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

function strip(s: string): string {
  return s.replace(/\[[0-9;]*m/g, "");
}

describe("renderRules", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("prints an empty-state hint when nothing has been learned", () => {
    const out = strip(renderRules(db));
    expect(out).toContain("No rules yet.");
    expect(out).toContain("plasalid clarify");
  });

  it("lists memory rules and merchant rules under a single unified header with running mch ids", () => {
    saveMemory(db, "Lazada Thailand is shopping.", "scanning_hint");
    saveMemory(db, "Spotify is Subscription.", "scanning_hint");
    upsertMerchant(db, { canonical_name: "Amazon", default_account_id: "expense:shopping" });
    upsertMerchant(db, { canonical_name: "Starbucks", default_account_id: "expense:food" });
    upsertMerchant(db, { canonical_name: "Spotify", default_account_id: "expense:subscriptions" });

    const out = strip(renderRules(db));
    expect(out).toContain("Rules (5):");
    expect(out).toContain("Lazada Thailand is shopping.");
    expect(out).toContain("Spotify is Subscription.");
    expect(out).toContain("mch:1");
    expect(out).toContain("mch:2");
    expect(out).toContain("mch:3");
    expect(out).toContain("Amazon → expense:shopping");
    expect(out).toContain("Starbucks → expense:food");
    expect(out).toContain("Spotify → expense:subscriptions");
    expect(out).not.toMatch(/mch:m:/);
    expect(out).not.toContain("merchant default");
    expect(out).not.toContain("Memory rules");
    expect(out).toContain("plasalid forget <regex>");
  });

  it("skips merchants with no default", () => {
    upsertMerchant(db, { canonical_name: "Starbucks" });
    const out = strip(renderRules(db));
    expect(out).toContain("No rules yet.");
  });

  it("orders merchants alphabetically by canonical_name", () => {
    upsertMerchant(db, { canonical_name: "Zara", default_account_id: "expense:shopping" });
    upsertMerchant(db, { canonical_name: "Amazon", default_account_id: "expense:shopping" });
    upsertMerchant(db, { canonical_name: "Muji", default_account_id: "expense:shopping" });

    const out = strip(renderRules(db));
    const amazonLine = out.indexOf("Amazon");
    const mujiLine = out.indexOf("Muji");
    const zaraLine = out.indexOf("Zara");
    expect(amazonLine).toBeLessThan(mujiLine);
    expect(mujiLine).toBeLessThan(zaraLine);
  });
});

describe("forgetRules", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("removes a single memory by its exact id", () => {
    saveMemory(db, "Lazada Thailand is shopping.", "scanning_hint");
    saveMemory(db, "Spotify is Subscription.", "scanning_hint");
    const [first] = getMemories(db);
    const outcome = forgetRules(db, `mem:${first.id}`);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.matched).toHaveLength(1);
      expect(outcome.matched[0].text).toBe(first.content);
    }
    expect(getMemories(db).find((m) => m.id === first.id)).toBeUndefined();
  });

  it("removes a single merchant rule by its running mch id", () => {
    upsertMerchant(db, { canonical_name: "Starbucks", default_account_id: "expense:food" });
    const outcome = forgetRules(db, "mch:1");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.matched).toHaveLength(1);
      expect(outcome.matched[0].displayId).toBe("mch:1");
      expect(outcome.matched[0].text).toBe("Starbucks → expense:food");
    }
    const merchants = listMerchants(db);
    expect(merchants.find((m) => m.canonical_name === "Starbucks")!.default_account_id).toBeNull();
  });

  it("removes every merchant rule with mch:.*", () => {
    upsertMerchant(db, { canonical_name: "Amazon", default_account_id: "expense:shopping" });
    upsertMerchant(db, { canonical_name: "Starbucks", default_account_id: "expense:food" });
    upsertMerchant(db, { canonical_name: "Spotify", default_account_id: "expense:subscriptions" });

    const outcome = forgetRules(db, "mch:.*");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.matched).toHaveLength(3);
    expect(listMerchants(db, { withDefaultOnly: true })).toHaveLength(0);
  });

  it("removes everything with .*", () => {
    saveMemory(db, "Lazada Thailand is shopping.", "scanning_hint");
    saveMemory(db, "Spotify is Subscription.", "scanning_hint");
    upsertMerchant(db, { canonical_name: "Amazon", default_account_id: "expense:shopping" });

    const outcome = forgetRules(db, ".*");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.matched).toHaveLength(3);
    expect(getMemories(db)).toHaveLength(0);
    expect(listMerchants(db, { withDefaultOnly: true })).toHaveLength(0);
  });

  it("anchors the regex so mem:5 does not match mem:50", () => {
    saveMemory(db, "first", "general");
    // bump the auto-increment id with stand-ins so a 5 and a 50 can both exist
    for (let i = 0; i < 60; i++) saveMemory(db, `m${i}`, "general");
    const memories = getMemories(db);
    const mem5 = memories.find((m) => m.id === 5);
    const mem50 = memories.find((m) => m.id === 50);
    expect(mem5).toBeTruthy();
    expect(mem50).toBeTruthy();

    const outcome = forgetRules(db, "mem:5");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.matched).toHaveLength(1);
      expect(outcome.matched[0].displayId).toBe("mem:5");
    }
    expect(getMemories(db).find((m) => m.id === 5)).toBeUndefined();
    expect(getMemories(db).find((m) => m.id === 50)).toBeTruthy();
  });

  it("uses a single snapshot so a batch like mch:(1|3) refers to the original ordering", () => {
    upsertMerchant(db, { canonical_name: "Apple", default_account_id: "expense:shopping" });
    upsertMerchant(db, { canonical_name: "Banana", default_account_id: "expense:shopping" });
    upsertMerchant(db, { canonical_name: "Cherry", default_account_id: "expense:shopping" });

    // mch:1 = Apple, mch:2 = Banana, mch:3 = Cherry. Removing 1 and 3 must
    // remove Apple and Cherry, not Apple and whatever-shifted-to-3.
    const outcome = forgetRules(db, "mch:(1|3)");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const names = outcome.matched.map((m) => m.text);
      expect(names.some((t) => t.startsWith("Apple "))).toBe(true);
      expect(names.some((t) => t.startsWith("Cherry "))).toBe(true);
      expect(names.some((t) => t.startsWith("Banana "))).toBe(false);
    }
    const stillWithDefault = listMerchants(db, { withDefaultOnly: true });
    expect(stillWithDefault.map((m) => m.canonical_name)).toEqual(["Banana"]);
  });

  it("returns ok:false when nothing matches", () => {
    saveMemory(db, "lonely rule", "general");
    const outcome = forgetRules(db, "mch:99");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("No rule matches /mch:99/");
    // and didn't touch the memory
    expect(getMemories(db)).toHaveLength(1);
  });

  it("returns ok:false on invalid regex", () => {
    saveMemory(db, "lonely rule", "general");
    const outcome = forgetRules(db, "[");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("Invalid regex");
    expect(getMemories(db)).toHaveLength(1);
  });

  it("returns ok:false when the rule store is empty", () => {
    const outcome = forgetRules(db, ".*");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("No rule matches");
  });

  it("renderRules' mch numbering matches forgetRules' resolution", () => {
    upsertMerchant(db, { canonical_name: "Apple", default_account_id: "expense:shopping" });
    upsertMerchant(db, { canonical_name: "Zara", default_account_id: "expense:shopping" });
    const rendered = strip(renderRules(db));
    // First merchant in display = Apple (alphabetical order)
    expect(rendered.indexOf("mch:1")).toBeLessThan(rendered.indexOf("mch:2"));
    const outcome = forgetRules(db, "mch:1");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.matched[0].text).toBe("Apple → expense:shopping");
    expect(findMerchantById(db, listMerchants(db).find((m) => m.canonical_name === "Apple")!.id)!.default_account_id).toBeNull();
  });
});
