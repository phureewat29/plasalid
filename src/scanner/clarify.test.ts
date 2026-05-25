import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { createAccount } from "../db/queries/account-balance.js";
import { upsertMerchant } from "../db/queries/merchants.js";
import { recordTransaction } from "../db/queries/transactions.js";
import { listQuestions } from "../db/queries/questions.js";
import { runClarify } from "./clarify.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "asset:cash", name: "Cash", type: "asset", parent_id: "asset" });
  return db;
}

describe("runClarify (non-interactive)", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("auto-merges strict duplicate transactions before counting questions", async () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" });
    db.prepare(
      `INSERT INTO scanned_files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, ?)`,
    ).run("f:1", "/f1.pdf", "hash1", "application/pdf", "scanned");

    for (let i = 0; i < 2; i++) {
      recordTransaction(db, {
        date: "2026-05-01",
        description: "Starbucks",
        merchant_id: merchant.id,
        source_file_id: "f:1",
        postings: [
          { account_id: "expense:food", debit: 150 },
          { account_id: "asset:cash", credit: 150 },
        ],
      });
    }

    const out = await runClarify({ db, interactive: false });
    expect(out.tally["dedup_auto_merge"]).toBe(1);
    expect(out.remaining).toBe(0);
    expect(listQuestions(db)).toHaveLength(0);
  });
});
