import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { generateKey } from "../db/encryption.js";
import {
  suggestPattern,
  findCandidates,
  savePassword,
  recordUse,
} from "./password-store.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

describe("suggestPattern", () => {
  it("takes the leading prefix before the first separator", () => {
    expect(suggestPattern("AcctSt_May26.pdf")).toBe("^acctst.*");
  });

  it("treats hyphens as separators too", () => {
    expect(suggestPattern("KBank-Savings-2026-01.pdf")).toBe("^kbank.*");
  });

  it("uses the bare stem for filenames with no separator", () => {
    expect(suggestPattern("statement.pdf")).toBe("^statement.*");
  });

  it("operates on basename only", () => {
    expect(suggestPattern("/tmp/data/Foo-1.pdf")).toBe("^foo.*");
  });

  it("escapes regex meta characters in the prefix", () => {
    expect(suggestPattern("a+b_2026.pdf")).toBe("^a\\+b.*");
  });

  it("falls back to digit-collapse when prefix is too short", () => {
    expect(suggestPattern("e-statement-may.pdf")).toBe("^e-statement-may\\.pdf$");
  });

  it("falls back when filename doesn't start with a letter", () => {
    expect(suggestPattern("1234567890.pdf")).toBe("^\\d+\\.pdf$");
  });
});

describe("password store", () => {
  let db: Database.Database;
  const dbKey = generateKey();
  beforeEach(() => {
    db = freshDb();
  });

  it("round-trips a password through the encrypted column", () => {
    const id = savePassword(db, "^kbank-\\d+\\.pdf$", "hunter2", dbKey);
    const matches = findCandidates(db, "/data/kbank-2026.pdf", dbKey);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(id);
    expect(matches[0].password).toBe("hunter2");
  });

  it("matches case-insensitively against the basename", () => {
    savePassword(db, "^kbank-\\d+\\.pdf$", "pw", dbKey);
    expect(findCandidates(db, "KBANK-2026.PDF", dbKey)).toHaveLength(1);
  });

  it("returns nothing for non-matching filenames", () => {
    savePassword(db, "^kbank-\\d+\\.pdf$", "pw", dbKey);
    expect(findCandidates(db, "ktc-2026.pdf", dbKey)).toEqual([]);
  });

  it("replaces the password and resets use_count on upsert", () => {
    const id = savePassword(db, "^kbank\\.pdf$", "old", dbKey);
    recordUse(db, id);
    recordUse(db, id);
    savePassword(db, "^kbank\\.pdf$", "new", dbKey);
    const matches = findCandidates(db, "kbank.pdf", dbKey);
    expect(matches[0].password).toBe("new");
    expect(matches[0].useCount).toBe(0);
  });

  it("orders candidates by use_count DESC", () => {
    const a = savePassword(db, "^a\\.pdf$", "pa", dbKey);
    const b = savePassword(db, "^.\\.pdf$", "pb", dbKey); // also matches "a.pdf"
    recordUse(db, b);
    recordUse(db, b);
    recordUse(db, a);
    const matches = findCandidates(db, "a.pdf", dbKey);
    expect(matches.map(m => m.id)).toEqual([b, a]);
  });
});
