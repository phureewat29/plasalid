import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../../db/schema.js";
import { createAccount } from "../../db/queries/account-balance.js";
import { executeTool } from "./index.js";

function freshDb() {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  migrate(d);
  createAccount(d, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(d, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  return d;
}

describe("executeTool error tagging", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("returns isError=false on a successful tool call", async () => {
    const res = await executeTool(db, "list_accounts", {});
    expect(res.isError).toBe(false);
    expect(res.content).toBeTruthy();
  });

  it("returns isError=true on an unknown tool name", async () => {
    const res = await executeTool(db, "does_not_exist_tool", {});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Unknown tool");
  });

  it("returns isError=true when a mutation throws (e.g. merge_accounts on missing ids)", async () => {
    // merge_accounts throws when the source has children; easier to trigger
    // by passing non-existent ids, which will throw a FK / lookup error.
    const res = await executeTool(db, "merge_accounts", {
      from_id: "does:not:exist",
      to_id: "also:missing",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toBeTruthy();
  });
});
