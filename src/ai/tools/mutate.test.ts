import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../../db/schema.js";
import { createAccount } from "../../db/queries/account-balance.js";
import { recordTransaction } from "../../db/queries/transactions.js";
import { mutateTools } from "./mutate.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "income", name: "Income", type: "income", parent_id: null });
  createAccount(db, { id: "asset:kbank", name: "KBank", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "income:uncategorized", name: "Uncategorized Income", type: "income", parent_id: "income" });
  createAccount(db, { id: "income:salary", name: "Salary", type: "income", parent_id: "income" });
  return db;
}

describe("bulk_update_postings tool", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("returns a human-readable summary with the count and sample ids", async () => {
    recordTransaction(db, {
      date: "2026-02-01",
      description: "บริษัท คริปโตมายด์ payroll",
      postings: [
        { account_id: "asset:kbank", debit: 50000 },
        { account_id: "income:uncategorized", credit: 50000 },
      ],
    });
    const out = await mutateTools.execute(
      db,
      "bulk_update_postings",
      {
        filter: { account_id: "income:uncategorized", description_contains: "คริปโตมาย" },
        set: { account_id: "income:salary" },
      },
      undefined,
    );
    expect(out).toBeTruthy();
    expect(out).toMatch(/Updated 1 posting/);
    expect(out).toMatch(/account_id=income:salary/);
    expect(out).toMatch(/p:/);
  });

  it("returns a no-match message when nothing matches", async () => {
    const out = await mutateTools.execute(
      db,
      "bulk_update_postings",
      {
        filter: { description_contains: "nothing" },
        set: { account_id: "income:salary" },
      },
      undefined,
    );
    expect(out).toMatch(/No postings matched/);
  });

  it("returns an error message (not throws) on invalid input", async () => {
    const out = await mutateTools.execute(
      db,
      "bulk_update_postings",
      { filter: {}, set: { account_id: "income:salary" } },
      undefined,
    );
    expect(out).toMatch(/Could not bulk update/);
  });

  it("returns undefined for unrelated tool names", async () => {
    const out = await mutateTools.execute(db, "something_else", {}, undefined);
    expect(out).toBeUndefined();
  });
});
