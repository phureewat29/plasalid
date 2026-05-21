import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { createAccount } from "../db/queries/account-balance.js";
import {
  recordUnknown,
  resolveUnknown,
  countOpenUnknowns,
  listOpenUnknowns,
} from "../db/queries/unknowns.js";

let db: Database.Database;
const runResolveAgentMock = vi.fn();

vi.mock("../db/connection.js", () => ({
  getDb: () => db,
}));

vi.mock("../ai/agent.js", () => ({
  runResolveAgent: (...args: any[]) => runResolveAgentMock(...args),
}));

// Suppress spinner output in tests.
vi.mock("../cli/ux.js", () => ({
  statusSpinner: () => ({
    text: "",
    succeed: () => {},
    fail: () => {},
    info: () => {},
    stop: () => {},
    pause: () => {},
    resume: () => {},
  }),
  makePromptUser: () => async () => "Skip — test",
  makeAgentOnProgress: () => () => {},
}));

import { runResolve } from "./pipeline.js";

function freshDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  migrate(d);
  createAccount(d, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  return d;
}

function seedUnknowns(d: Database.Database, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(recordUnknown(d, {
      file_id: null,
      transaction_id: null,
      account_id: null,
      kind: "uncategorized_expense",
      prompt: `unknown ${i}`,
    }));
  }
  return ids;
}

describe("runResolve outer loop", () => {
  beforeEach(() => {
    db = freshDb();
    runResolveAgentMock.mockReset();
  });

  it("returns early when there are no open unknowns", async () => {
    const result = await runResolve();
    expect(result).toBe("No unknowns to resolve.");
    expect(runResolveAgentMock).not.toHaveBeenCalled();
  });

  it("loops until countOpenUnknowns reaches 0", async () => {
    const ids = seedUnknowns(db, 5);
    let cursor = 0;
    // Each agent invocation closes 2 unknowns.
    runResolveAgentMock.mockImplementation(async () => {
      for (let i = 0; i < 2 && cursor < ids.length; i++) {
        resolveUnknown(db, ids[cursor++], "test answer");
      }
      return "iteration done";
    });

    const result = await runResolve();
    // 5 unknowns, 2 per iter → 3 iters (close 2, close 2, close 1).
    expect(runResolveAgentMock).toHaveBeenCalledTimes(3);
    expect(countOpenUnknowns(db)).toBe(0);
    expect(result).toContain("Resolved 5");
  });

  it("breaks the loop with a no-progress notice when nothing closes", async () => {
    seedUnknowns(db, 3);
    runResolveAgentMock.mockImplementation(async () => "did nothing");

    const result = await runResolve();
    // First iter ran (decremented prevOpen from Infinity to 3); second iter
    // sees open >= prevOpen and breaks.
    expect(runResolveAgentMock).toHaveBeenCalledTimes(1);
    expect(countOpenUnknowns(db)).toBe(3);
    expect(result).toContain("3 still open");
  });

  it("caps at 3 iterations even when each pass closes some", async () => {
    const ids = seedUnknowns(db, 20);
    let cursor = 0;
    runResolveAgentMock.mockImplementation(async () => {
      // Close one per iter so progress moves but slowly.
      if (cursor < ids.length) resolveUnknown(db, ids[cursor++], "test");
      return "iter";
    });

    const result = await runResolve();
    expect(runResolveAgentMock).toHaveBeenCalledTimes(3);
    expect(countOpenUnknowns(db)).toBe(17);
    expect(result).toContain("17 still open");
  });

  it("hands each iteration the still-open list, not the original snapshot", async () => {
    const ids = seedUnknowns(db, 4);
    const seen: number[] = [];
    let cursor = 0;
    runResolveAgentMock.mockImplementation(async () => {
      seen.push(listOpenUnknowns(db).length);
      if (cursor < ids.length) resolveUnknown(db, ids[cursor++], "test");
      return "iter";
    });

    await runResolve();
    expect(seen).toEqual([4, 3, 2]); // hits 3-iter cap before reaching 0
  });

  it("scopes filtering by kind through to the count + listing", async () => {
    // 2 uncategorized + 2 duplicate.
    seedUnknowns(db, 2);
    for (let i = 0; i < 2; i++) {
      recordUnknown(db, {
        file_id: null,
        transaction_id: null,
        account_id: null,
        kind: "duplicate",
        prompt: `dup ${i}`,
      });
    }
    runResolveAgentMock.mockImplementation(async () => {
      // Don't touch anything → no progress → loop exits after one pass.
      return "noop";
    });

    await runResolve({ kind: "duplicate" });
    expect(runResolveAgentMock).toHaveBeenCalledTimes(1);
    // The kind filter only sees the 2 duplicates.
    const initialPromptArg = runResolveAgentMock.mock.calls[0][0];
    const userText = initialPromptArg.initialMessages[0].content as string;
    expect(userText).toContain("2 open unknown(s)");
  });
});
