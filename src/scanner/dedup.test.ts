import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { createAccount } from "../db/queries/account-balance.js";
import { upsertMerchant } from "../db/queries/merchants.js";
import {
  recordTransaction,
  countTransactions,
} from "../db/queries/transactions.js";
import { autoMergeStrictDuplicates } from "./dedup.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "asset:cash", name: "Cash", type: "asset", parent_id: "asset" });
  return db;
}

describe("autoMergeStrictDuplicates", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("merges exact duplicates sharing merchant/file/date/amount", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" });
    db.prepare(
      `INSERT INTO scanned_files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, ?)`,
    ).run("sf:1", "/f1.pdf", "hash1", "application/pdf", "scanned");

    for (let i = 0; i < 3; i++) {
      recordTransaction(db, {
        date: "2026-05-01",
        description: "Starbucks",
        merchant_id: merchant.id,
        source_file_id: "sf:1",
        postings: [
          { account_id: "expense:food", debit: 150 },
          { account_id: "asset:cash", credit: 150 },
        ],
      });
    }

    expect(countTransactions(db).transactions).toBe(3);
    expect(autoMergeStrictDuplicates(db)).toEqual({ merged: 2 });
    expect(countTransactions(db).transactions).toBe(1);
  });

  it("keeps distinct amounts untouched", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" });
    db.prepare(
      `INSERT INTO scanned_files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, ?)`,
    ).run("sf:1", "/f1.pdf", "hash1", "application/pdf", "scanned");

    for (const amount of [150, 175]) {
      recordTransaction(db, {
        date: "2026-05-01",
        description: "Starbucks",
        merchant_id: merchant.id,
        source_file_id: "sf:1",
        postings: [
          { account_id: "expense:food", debit: amount },
          { account_id: "asset:cash", credit: amount },
        ],
      });
    }

    expect(autoMergeStrictDuplicates(db)).toEqual({ merged: 0 });
    expect(countTransactions(db).transactions).toBe(2);
  });
});
