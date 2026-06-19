import { describe, it, expect } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import { listPasswords, deletePassword } from "./vault.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function insertPassword(
  db: Database.Database,
  id: string,
  pattern: string,
  opts: { useCount?: number; lastUsedAt?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO file_passwords (id, pattern, password_encrypted, use_count, last_used_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, pattern, "cipher-text-not-a-real-secret", opts.useCount ?? 0, opts.lastUsedAt ?? null);
}

describe("listPasswords", () => {
  it("returns rows without the encrypted password", () => {
    const db = freshDb();
    insertPassword(db, "fp:a", "^kbank.*", { useCount: 3, lastUsedAt: "2026-05-24 10:00:00" });

    const rows = listPasswords(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: "fp:a",
      pattern: "^kbank.*",
      use_count: 3,
      last_used_at: "2026-05-24 10:00:00",
    });
    expect(rows[0]).not.toHaveProperty("password_encrypted");
    expect(Object.values(rows[0] as any)).not.toContain("cipher-text-not-a-real-secret");
  });

  it("returns an empty array when no passwords are stored", () => {
    expect(listPasswords(freshDb())).toEqual([]);
  });
});

describe("deletePassword", () => {
  it("deletes by id", () => {
    const db = freshDb();
    insertPassword(db, "fp:a", "^kbank.*");

    expect(deletePassword(db, "fp:a")).toBe(true);
    expect(listPasswords(db)).toHaveLength(0);
  });

  it("deletes by exact pattern", () => {
    const db = freshDb();
    insertPassword(db, "fp:a", "^kbank.*");

    expect(deletePassword(db, "^kbank.*")).toBe(true);
    expect(listPasswords(db)).toHaveLength(0);
  });

  it("returns false when nothing matches", () => {
    const db = freshDb();
    insertPassword(db, "fp:a", "^kbank.*");

    expect(deletePassword(db, "nope")).toBe(false);
    expect(listPasswords(db)).toHaveLength(1);
  });
});
