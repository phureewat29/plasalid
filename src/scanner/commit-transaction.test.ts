import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import {
  createAccount,
  getAccountBalancesFromTransactions,
} from "../db/queries/account-balance.js";
import {
  countTransactions,
  getTransaction,
  deriveTransactionId,
  deriveGroupId,
} from "../db/queries/transactions.js";
import { listQuestions, countQuestions } from "../db/queries/questions.js";
import {
  commitTransaction,
  commitLinkedTransactions,
  type TransactionCommitContext,
  type RawTransactionInput,
} from "./commit-transaction.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare(
    `INSERT INTO scanned_files (id, path, file_hash, mime, status) VALUES ('sf:1','/f.pdf','hashABC','application/pdf','scanned')`,
  ).run();
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "asset:cash", name: "Cash", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "asset:bank", name: "KBank Savings", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "income", name: "Income", type: "income", parent_id: null });
  createAccount(db, { id: "income:salary", name: "Salary", type: "income", parent_id: "income" });
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "expense:tax", name: "Tax", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "expense:tax:withholding", name: "Withholding", type: "expense", parent_id: "expense:tax" });
  createAccount(db, { id: "expense:social-security", name: "Social Security", type: "expense", parent_id: "expense" });
  return db;
}

const CTX: TransactionCommitContext = {
  scanId: "sc:1",
  fileId: "sf:1",
  fileHash: "hashABC",
  chunkId: null,
  progress: null,
};

function raw(over: Partial<RawTransactionInput> = {}): RawTransactionInput {
  return {
    date: "2026-05-01",
    description: "Coffee",
    debit_account_id: "expense:food",
    credit_account_id: "asset:cash",
    amount: 135.0,
    currency: "THB",
    row_index: 0,
    source_page: 1,
    ...over,
  };
}

describe("commitTransaction", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("happy path: converts decimal to minor units, derives id, raises no questions", () => {
    const out = commitTransaction(db, CTX, raw());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.duplicate).toBe(false);
    expect(out.raisedQuestions).toBe(0);
    expect(out.transactionId).toBe(deriveTransactionId("hashABC", 1, 0));

    const row = getTransaction(db, out.transactionId)!;
    expect(row.amount).toBe(13500); // 135.00 THB -> minor units
    expect(row.debit_account_id).toBe("expense:food");
    expect(countQuestions(db)).toBe(0);
  });

  it("raises a per-side question when an account resolves to a placeholder", () => {
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "expense:mystery-thing", row_index: 1 }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.raisedQuestions).toBe(1);

    const qs = listQuestions(db);
    expect(qs).toHaveLength(1);
    expect(qs[0].transaction_id).toBe(out.transactionId);
    expect(qs[0].kind).toBe("uncategorized");
    expect(JSON.parse(qs[0].context_json!).side).toBe("debit");
    // The transaction still committed against the created placeholder account.
    expect(countTransactions(db)).toBe(1);
  });

  it("drops a cross-currency transaction and raises currency_mismatch (no insert)", () => {
    createAccount(db, { id: "asset:usd", name: "USD Wallet", type: "asset", parent_id: "asset", currency: "USD" });
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "asset:usd", credit_account_id: "asset:cash", currency: "USD", row_index: 5 }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("currency_mismatch");
    expect(countTransactions(db)).toBe(0);

    const cm = listQuestions(db).find((q) => q.kind === "currency_mismatch")!;
    expect(cm).toBeTruthy();
    expect(cm.transaction_id).toBeNull();
  });

  it("is idempotent: a re-commit is a duplicate with no balance change / questions", () => {
    const input = raw({ row_index: 9 });
    const a = commitTransaction(db, CTX, input);
    const b = commitTransaction(db, CTX, input);
    expect(a.ok && !a.duplicate).toBe(true);
    expect(b.ok && b.duplicate).toBe(true);
    if (b.ok) expect(b.raisedQuestions).toBe(0);
    expect(countTransactions(db)).toBe(1);
  });

  it("no-ops every question raise when scanId is null", () => {
    const out = commitTransaction(
      db,
      { ...CTX, scanId: null },
      raw({ debit_account_id: "expense:mystery-thing", row_index: 2 }),
    );
    expect(out.ok).toBe(true);
    // Placeholder still created and transaction committed, but no question persisted.
    expect(countQuestions(db, { includeDeferred: true })).toBe(0);
  });

  it("fuzzy-collapse guard: a fuzzy match onto the other side's account creates a placeholder instead of failing", () => {
    // Existing account whose name shares the "ttb" token with the debit hint below.
    createAccount(db, { id: "liability", name: "Liabilities", type: "liability", parent_id: null });
    createAccount(db, { id: "liability:credit_card", name: "Credit Cards", type: "liability", parent_id: "liability" });
    createAccount(db, {
      id: "liability:credit_card:ttb",
      name: "TTB Credit Card",
      type: "liability",
      parent_id: "liability:credit_card",
    });

    const out = commitTransaction(
      db,
      CTX,
      raw({
        debit_account_id: "asset:bank:ttb",
        credit_account_id: "liability:credit_card:ttb",
        row_index: 6,
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const row = getTransaction(db, out.transactionId)!;
    // The debit side was NOT collapsed onto the credit account: it landed on
    // a freshly created placeholder using the original requested id.
    expect(row.debit_account_id).toBe("asset:bank:ttb");
    expect(row.credit_account_id).toBe("liability:credit_card:ttb");

    const qs = listQuestions(db);
    expect(qs).toHaveLength(1);
    expect(qs[0].kind).toBe("uncategorized");
    expect(JSON.parse(qs[0].context_json!)).toMatchObject({ side: "debit", placeholder_id: "asset:bank:ttb" });
  });

  it("keeps the dirty_input failure when debit and credit collapse with no fuzzy match involved", () => {
    // "bogus" and "also-bogus" aren't prefixed with a known account type, so
    // both fall through fuzzy match (no name comes close) straight to the
    // expense:uncategorized fallback — a genuine collision, not a fuzzy one.
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "bogus", credit_account_id: "also-bogus", row_index: 7 }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("dirty_input");
    expect(countTransactions(db)).toBe(0);
  });
});

describe("commitLinkedTransactions", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("commits the salary example atomically with a shared group and gross income", () => {
    const out = commitLinkedTransactions(
      db,
      CTX,
      { date: "2026-05-25", description: "May salary", row_index: 0, source_page: 2 },
      [
        { debit_account_id: "asset:bank", credit_account_id: "income:salary", amount: 50000 },
        { debit_account_id: "expense:tax:withholding", credit_account_id: "income:salary", amount: 8000 },
        { debit_account_id: "expense:social-security", credit_account_id: "income:salary", amount: 2000 },
      ],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results).toHaveLength(3);
    expect(out.group_id).toBe(deriveGroupId("hashABC", 2, 0));
    expect(countTransactions(db)).toBe(3);

    // income:salary is credited by all three legs: 60000 THB gross.
    const salary = getAccountBalancesFromTransactions(db).find((b) => b.id === "income:salary")!;
    expect(salary.credits_posted).toBe(6_000_000); // minor units
    expect(salary.balance).toBe(60000); // decimal, credit-normal

    // Every leg shares the group id.
    for (const r of out.results) {
      expect(getTransaction(db, r.id)?.group_id).toBe(out.group_id);
    }
  });

  it("rolls back all legs when one leg is invalid", () => {
    const out = commitLinkedTransactions(
      db,
      CTX,
      { date: "2026-05-25", description: "bad batch", row_index: 3, source_page: 2 },
      [
        { debit_account_id: "asset:bank", credit_account_id: "income:salary", amount: 100 },
        { debit_account_id: "asset:bank", credit_account_id: "asset:bank", amount: 50 }, // debit == credit
      ],
    );
    expect(out.ok).toBe(false);
    expect(countTransactions(db)).toBe(0);
  });
});
