import { describe, it, expect } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import {
  countScannedFiles,
  deleteScannedFile,
  findScannedFileById,
  listScannedFiles,
} from "./files.js";
import { createAccount } from "./account-balance.js";
import { recordTransaction } from "./transactions.js";
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
  it("returns rows including the new provider/model columns", () => {
    const db = freshDb();
    insertFile(db, "a", "scanned");
    db.prepare(
      `UPDATE scanned_files SET provider = 'anthropic', model = 'claude-sonnet-4-6', scanned_at = '2026-05-24 10:00:00' WHERE id = ?`,
    ).run("a");
    insertFile(db, "b", "pending");

    const rows = listScannedFiles(db);
    expect(rows).toHaveLength(2);

    const scanned = rows.find(r => r.id === "a")!;
    expect(scanned.provider).toBe("anthropic");
    expect(scanned.model).toBe("claude-sonnet-4-6");

    const pending = rows.find(r => r.id === "b")!;
    expect(pending.provider).toBeNull();
    expect(pending.model).toBeNull();
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
    const txId = recordTransaction(db, {
      date: "2026-05-19",
      description: "Coffee",
      source_file_id: "a",
      postings: [
        { account_id: "expense:food", debit: 100 },
        { account_id: "asset:kbank", credit: 100 },
      ],
    });
    recordQuestion(db, {
      file_id: "a",
      transaction_id: txId,
      account_id: null,
      kind: "uncategorized",
      prompt: "Categorize this",
    });

    const result = deleteScannedFile(db, "a");

    expect(result.removed?.id).toBe("a");
    expect(result.removedTransactions).toBe(1);
    expect(result.removedQuestions).toBe(1);
    expect(findScannedFileById(db, "a")).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()).toMatchObject({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM postings`).get()).toMatchObject({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM questions`).get()).toMatchObject({ n: 0 });
  });

  it("returns null counts and no error when the id is unknown", () => {
    const result = deleteScannedFile(freshDb(), "nope");
    expect(result).toEqual({ removed: null, removedTransactions: 0, removedQuestions: 0 });
  });
});
