import { describe, it, expect } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import { countScannedFiles } from "./files.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function insertFile(db: Database.Database, id: string, status: "pending" | "scanned" | "failed"): void {
  db.prepare(
    `INSERT INTO scanned_files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, `/tmp/${id}.pdf`, `hash-${id}`, "application/pdf", status);
}

describe("countScannedFiles", () => {
  it("returns all zeros for an empty table", () => {
    expect(countScannedFiles(freshDb())).toEqual({ scanned: 0, pending: 0, failed: 0 });
  });

  it("buckets rows by status", () => {
    const db = freshDb();
    insertFile(db, "a", "scanned");
    insertFile(db, "b", "scanned");
    insertFile(db, "c", "scanned");
    insertFile(db, "d", "pending");
    insertFile(db, "e", "failed");
    insertFile(db, "f", "failed");

    expect(countScannedFiles(db)).toEqual({ scanned: 3, pending: 1, failed: 2 });
  });
});
