import { describe, it, expect } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { runScan, type StageName } from "./engine.js";
import { AbortedError } from "../ai/errors.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

describe("runScan stage chain", () => {
  it("stops on abort and skips later stages", async () => {
    const db = freshDb();
    const controller = new AbortController();
    let clarified = false;
    const stages: { name: StageName; stage: () => Promise<void> }[] = [
      {
        name: "parse",
        stage: async () => {
          controller.abort();
        },
      },
      {
        name: "clarify",
        stage: async () => {
          clarified = true;
        },
      },
    ];

    await expect(
      runScan(db, { stages }, {}, controller.signal),
    ).rejects.toBeInstanceOf(AbortedError);
    expect(clarified).toBe(false);
  });
});
