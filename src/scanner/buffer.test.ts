import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { BufferedWriteContext } from "./buffer.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  // Seed accounts + scanned_files row so FKs hold.
  db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`).run("a:cash", "Cash", "asset");
  db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`).run("a:food", "Food", "expense");
  db.prepare(
    `INSERT INTO scanned_files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, 'pending')`,
  ).run("sf:test", "/x.pdf", "deadbeef", "application/pdf");
  return db;
}

describe("BufferedWriteContext", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("queues entries and concerns without touching the DB until commit()", () => {
    const buf = new BufferedWriteContext("x.pdf");
    const entryId = buf.appendEntry({
      date: "2026-01-15",
      description: "Lunch",
      lines: [
        { account_id: "a:food", debit: 100 },
        { account_id: "a:cash", credit: 100 },
      ],
    });
    buf.appendConcern({ entry_id: entryId, account_id: null, prompt: "Is this category right?" });

    expect(db.prepare(`SELECT COUNT(*) AS n FROM journal_entries`).get()).toMatchObject({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM concerns`).get()).toMatchObject({ n: 0 });

    const counts = buf.commit(db, "sf:test");
    expect(counts).toEqual({ entries: 1, concerns: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM journal_entries`).get()).toMatchObject({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM concerns`).get()).toMatchObject({ n: 1 });

    // The concern's entry_id must point at the entry that just landed.
    const concern = db.prepare(`SELECT entry_id FROM concerns LIMIT 1`).get() as { entry_id: string };
    expect(concern.entry_id).toBe(entryId);
  });

  it("rolls back the DB on a mid-commit error", () => {
    const buf = new BufferedWriteContext("x.pdf");
    buf.appendEntry({
      date: "2026-01-15",
      description: "Good entry",
      lines: [
        { account_id: "a:food", debit: 100 },
        { account_id: "a:cash", credit: 100 },
      ],
    });
    // This second entry is unbalanced and will throw during commit.
    buf.appendEntry({
      date: "2026-01-16",
      description: "Bad entry",
      lines: [
        { account_id: "a:food", debit: 100 },
        { account_id: "a:cash", credit: 50 },
      ],
    });

    expect(() => buf.commit(db, "sf:test")).toThrow(/does not balance/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM journal_entries`).get()).toMatchObject({ n: 0 });
  });

  it("markDone records the summary", () => {
    const buf = new BufferedWriteContext("x.pdf");
    expect(buf.isDone).toBe(false);
    buf.markDone("Parsed 3 transactions.");
    expect(buf.isDone).toBe(true);
    expect(buf.doneSummary).toBe("Parsed 3 transactions.");
  });
});
