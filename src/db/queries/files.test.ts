import { describe, it, expect } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import {
  countScannedFiles,
  deleteScannedFile,
  findScannedFileById,
  listScannedFiles,
  markFileScanned,
  markFileFailed,
} from "./files.js";
import { createAccount } from "./account-balance.js";
import { insertTransfer } from "./transfers.js";
import { recordQuestion } from "./questions.js";

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

function seedChartOfAccounts(db: Database.Database): void {
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "asset:kbank", name: "KBank", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
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

describe("listScannedFiles / findScannedFileById", () => {
  it("returns rows including the source column", () => {
    const db = freshDb();
    insertFile(db, "a", "scanned");
    db.prepare(
      `UPDATE scanned_files SET source = 'anthropic', scanned_at = '2026-05-24 10:00:00' WHERE id = ?`,
    ).run("a");
    insertFile(db, "b", "pending");

    const rows = listScannedFiles(db);
    expect(rows).toHaveLength(2);

    const scanned = rows.find(r => r.id === "a")!;
    expect(scanned.source).toBe("anthropic");

    const pending = rows.find(r => r.id === "b")!;
    expect(pending.source).toBeNull();
  });

  it("findScannedFileById returns null for an unknown id", () => {
    expect(findScannedFileById(freshDb(), "nope")).toBeNull();
  });
});

describe("deleteScannedFile", () => {
  it("returns the removed row plus cascade counts and wipes the dependents", () => {
    const db = freshDb();
    seedChartOfAccounts(db);
    insertFile(db, "a", "scanned");
    const { id: transferId } = insertTransfer(db, {
      date: "2026-05-19",
      description: "Coffee",
      source_file_id: "a",
      debit_account_id: "expense:food",
      credit_account_id: "asset:kbank",
      amount: 10000,
      currency: "THB",
    });
    recordQuestion(db, {
      file_id: "a",
      transfer_id: transferId,
      account_id: null,
      kind: "uncategorized",
      prompt: "Categorize this",
    });

    const result = deleteScannedFile(db, "a");

    expect(result.removed?.id).toBe("a");
    expect(result.removedTransfers).toBe(1);
    expect(result.removedQuestions).toBe(1);
    expect(findScannedFileById(db, "a")).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transfers`).get()).toMatchObject({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM questions`).get()).toMatchObject({ n: 0 });
  });

  it("returns null counts and no error when the id is unknown", () => {
    const result = deleteScannedFile(freshDb(), "nope");
    expect(result).toEqual({ removed: null, removedTransfers: 0, removedQuestions: 0 });
  });
});

describe("markFileScanned", () => {
  it("stamps status/source/scanned_at", () => {
    const db = freshDb();
    insertFile(db, "a", "pending");

    const changes = markFileScanned(db, "a", { source: "anthropic" });

    expect(changes).toBe(1);
    const row = findScannedFileById(db, "a")!;
    expect(row.status).toBe("scanned");
    expect(row.source).toBe("anthropic");
    expect(row.scanned_at).not.toBeNull();
  });

  it("returns 0 changes for an unknown id", () => {
    expect(markFileScanned(freshDb(), "nope", { source: "anthropic" })).toBe(0);
  });
});

describe("markFileFailed", () => {
  it("stamps status/source/error, leaving scanned_at untouched", () => {
    const db = freshDb();
    insertFile(db, "a", "pending");

    const changes = markFileFailed(db, "a", { source: "external", error: "boom" });

    expect(changes).toBe(1);
    const row = findScannedFileById(db, "a")!;
    expect(row.status).toBe("failed");
    expect(row.source).toBe("external");
    expect(row.error).toBe("boom");
    expect(row.scanned_at).toBeNull();
  });

  it("returns 0 changes for an unknown id", () => {
    expect(markFileFailed(freshDb(), "nope", { source: "external", error: "x" })).toBe(0);
  });
});
