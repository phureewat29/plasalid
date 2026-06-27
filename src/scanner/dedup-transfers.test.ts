import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { createAccount } from "../db/queries/account-balance.js";
import { upsertMerchant } from "../db/queries/merchants.js";
import { insertTransfer, countTransfers, type TransferInput } from "../db/queries/transfers.js";
import { autoMergeStrictDuplicateTransfers } from "./dedup-transfers.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "asset:cash", name: "Cash", type: "asset", parent_id: "asset" });
  db.prepare(
    `INSERT INTO scanned_files (id, path, file_hash, mime, status) VALUES ('sf:1','/f.pdf','h1','application/pdf','scanned')`,
  ).run();
  return db;
}

function tf(over: Partial<TransferInput>): TransferInput {
  return {
    date: "2026-05-01",
    description: "Starbucks",
    debit_account_id: "expense:food",
    credit_account_id: "asset:cash",
    amount: 15000,
    currency: "THB",
    source_file_id: "sf:1",
    ...over,
  };
}

describe("autoMergeStrictDuplicateTransfers", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("merges exact duplicates sharing merchant/file/date/amount", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" });
    for (let i = 0; i < 3; i++) {
      insertTransfer(db, tf({ merchant_id: merchant.id }));
    }
    expect(countTransfers(db)).toBe(3);
    expect(autoMergeStrictDuplicateTransfers(db)).toEqual({ merged: 2 });
    expect(countTransfers(db)).toBe(1);
  });

  it("keeps distinct amounts untouched", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" });
    for (const amount of [15000, 17500]) {
      insertTransfer(db, tf({ merchant_id: merchant.id, amount }));
    }
    expect(autoMergeStrictDuplicateTransfers(db)).toEqual({ merged: 0 });
    expect(countTransfers(db)).toBe(2);
  });

  it("does not merge when the earliest row lacks a merchant or source file", () => {
    for (let i = 0; i < 2; i++) {
      insertTransfer(db, tf({})); // no merchant_id
    }
    expect(autoMergeStrictDuplicateTransfers(db)).toEqual({ merged: 0 });
    expect(countTransfers(db)).toBe(2);
  });
});
