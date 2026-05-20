import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../../db/schema.js";
import { recordTransaction } from "../../db/queries/transactions.js";
import { listOpenUnknowns, listOpenUnknownsByKind } from "../../db/queries/unknowns.js";
import { runInspectors } from "./index.js";
import { duplicatesInspector } from "./duplicates.js";
import { correlationsInspector } from "./correlations.js";
import { recurrencesInspector } from "./recurrences.js";
import { similarAccountsInspector } from "./similarities.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`).run("asset", "Assets", "asset");
  db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`).run("liability", "Liabilities", "liability");
  db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`).run("expense", "Expenses", "expense");
  db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`).run("asset:kbank", "KBank Savings", "asset", "asset");
  db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`).run("asset:cash", "Cash", "asset", "asset");
  db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`).run("liability:ktc", "KTC Card", "liability", "liability");
  db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`).run("expense:food", "Food", "expense", "expense");
  db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`).run("expense:dining", "Dining", "expense", "expense");
  return db;
}

function makeScannedFile(db: Database.Database, id: string): string {
  db.prepare(`INSERT INTO scanned_files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, 'scanned')`)
    .run(id, `/tmp/${id}.pdf`, id, "application/pdf");
  return id;
}

describe("duplicatesInspector", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("flags a same-amount transaction within tolerance", () => {
    const file = makeScannedFile(db, "sf:1");
    recordTransaction(db, {
      source_file_id: file,
      date: "2026-02-01",
      description: "Lunch",
      postings: [{ account_id: "expense:food", debit: 350 }, { account_id: "asset:kbank", credit: 350 }],
    });
    recordTransaction(db, {
      source_file_id: file,
      date: "2026-02-02",
      description: "Lunch repeat",
      postings: [{ account_id: "expense:food", debit: 350 }, { account_id: "asset:kbank", credit: 350 }],
    });
    const unknowns = duplicatesInspector.inspect(db, { fileIds: [file] });
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0].kind).toBe("duplicate");
    expect(unknowns[0].prompt).toContain("Possible duplicate");
  });

  it("returns nothing when no transaction in scope is a duplicate", () => {
    const file = makeScannedFile(db, "sf:1");
    recordTransaction(db, {
      source_file_id: file,
      date: "2026-02-01",
      description: "Once",
      postings: [{ account_id: "expense:food", debit: 100 }, { account_id: "asset:kbank", credit: 100 }],
    });
    expect(duplicatesInspector.inspect(db, { fileIds: [file] })).toEqual([]);
  });

  it("returns nothing when scope is empty", () => {
    expect(duplicatesInspector.inspect(db, { fileIds: [] })).toEqual([]);
  });

  it("skips two same-file same-date same-merchant transactions (legit repeat charge)", () => {
    const file = makeScannedFile(db, "sf:1");
    db.prepare(`INSERT INTO merchants (id, canonical_name) VALUES (?, ?)`).run("m:starbucks", "Starbucks");
    recordTransaction(db, {
      source_file_id: file,
      date: "2026-02-01",
      description: "Starbucks",
      merchant_id: "m:starbucks",
      postings: [{ account_id: "expense:food", debit: 200 }, { account_id: "asset:kbank", credit: 200 }],
    });
    recordTransaction(db, {
      source_file_id: file,
      date: "2026-02-01",
      description: "Starbucks",
      merchant_id: "m:starbucks",
      postings: [{ account_id: "expense:food", debit: 200 }, { account_id: "asset:kbank", credit: 200 }],
    });
    expect(duplicatesInspector.inspect(db, { fileIds: [file] })).toEqual([]);
  });

  it("still flags two same-file same-date charges when the merchant differs", () => {
    const file = makeScannedFile(db, "sf:1");
    db.prepare(`INSERT INTO merchants (id, canonical_name) VALUES (?, ?)`).run("m:a", "Starbucks");
    db.prepare(`INSERT INTO merchants (id, canonical_name) VALUES (?, ?)`).run("m:b", "Dunkin");
    recordTransaction(db, {
      source_file_id: file,
      date: "2026-02-01",
      description: "Starbucks",
      merchant_id: "m:a",
      postings: [{ account_id: "expense:food", debit: 200 }, { account_id: "asset:kbank", credit: 200 }],
    });
    recordTransaction(db, {
      source_file_id: file,
      date: "2026-02-01",
      description: "Dunkin",
      merchant_id: "m:b",
      postings: [{ account_id: "expense:food", debit: 200 }, { account_id: "asset:kbank", credit: 200 }],
    });
    expect(duplicatesInspector.inspect(db, { fileIds: [file] })).toHaveLength(1);
  });
});

describe("correlationsInspector", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("flags two same-amount transactions on disjoint account sets", () => {
    const file = makeScannedFile(db, "sf:1");
    recordTransaction(db, {
      source_file_id: file,
      date: "2026-02-01",
      description: "Transfer to card",
      postings: [{ account_id: "liability:ktc", debit: 1000 }, { account_id: "asset:kbank", credit: 1000 }],
    });
    recordTransaction(db, {
      source_file_id: file,
      date: "2026-02-02",
      description: "Card payment received",
      postings: [{ account_id: "asset:cash", debit: 1000 }, { account_id: "expense:food", credit: 1000 }],
    });
    const unknowns = correlationsInspector.inspect(db, { fileIds: [file] });
    expect(unknowns.length).toBeGreaterThanOrEqual(1);
    expect(unknowns[0].kind).toBe("correlation");
  });
});

describe("recurrencesInspector", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("flags a monthly amount that appears 3+ times", () => {
    const file = makeScannedFile(db, "sf:1");
    for (const date of ["2025-12-01", "2026-01-01", "2026-02-01"]) {
      recordTransaction(db, {
        source_file_id: file,
        date,
        description: "Spotify",
        postings: [{ account_id: "expense:food", debit: 199 }, { account_id: "asset:kbank", credit: 199 }],
      });
    }
    // Both postings (the debit side and the credit side) form a recurrence
    // bucket, so we expect one unknown per side.
    const unknowns = recurrencesInspector.inspect(db, { fileIds: [file] });
    expect(unknowns.length).toBeGreaterThanOrEqual(1);
    expect(unknowns.every(u => u.kind === "recurrence_candidate")).toBe(true);
    expect(unknowns.some(u => u.prompt.includes("monthly"))).toBe(true);
  });

  it("skips irregular intervals", () => {
    const file = makeScannedFile(db, "sf:1");
    for (const date of ["2025-12-01", "2026-01-15", "2026-02-20"]) {
      recordTransaction(db, {
        source_file_id: file,
        date,
        description: "Misc",
        postings: [{ account_id: "expense:food", debit: 199 }, { account_id: "asset:kbank", credit: 199 }],
      });
    }
    expect(recurrencesInspector.inspect(db, { fileIds: [file] })).toEqual([]);
  });
});

describe("similarAccountsInspector", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("flags two near-identical account names", () => {
    db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`)
      .run("expense:groceries", "Grocery Store", "expense", "expense");
    db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`)
      .run("expense:grocery", "Grocery Stores", "expense", "expense");
    const file = makeScannedFile(db, "sf:1");
    const unknowns = similarAccountsInspector.inspect(db, { fileIds: [file] });
    expect(unknowns.length).toBeGreaterThanOrEqual(1);
    expect(unknowns[0].kind).toBe("similar_accounts");
  });

  it("does not re-flag an existing open similar_accounts unknown", () => {
    db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`)
      .run("expense:groceries", "Grocery Store", "expense", "expense");
    db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`)
      .run("expense:grocery", "Grocery Stores", "expense", "expense");
    const file = makeScannedFile(db, "sf:1");
    const first = similarAccountsInspector.inspect(db, { fileIds: [file] });
    expect(first.length).toBeGreaterThanOrEqual(1);
    // Insert what runInspectors would insert
    runInspectors(db, { fileIds: [file] });
    // Re-running shouldn't add another unknown for the same pair
    const second = similarAccountsInspector.inspect(db, { fileIds: [file] });
    expect(second).toEqual([]);
  });

  it("does not re-flag a pair the user previously resolved (e.g. answered Keep separate)", async () => {
    db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`)
      .run("expense:groceries", "Grocery Store", "expense", "expense");
    db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`)
      .run("expense:grocery", "Grocery Stores", "expense", "expense");
    const file = makeScannedFile(db, "sf:1");
    // Run inspectors once and record the resulting unknown
    const result = runInspectors(db, { fileIds: [file] });
    expect(result.byInspector.similar_accounts).toBeGreaterThanOrEqual(1);
    // Mark all open unknowns resolved with "Keep separate" as if the user answered
    db.prepare(`UPDATE unknowns SET answer = 'Keep separate', resolved_at = datetime('now') WHERE kind = 'similar_accounts'`).run();
    // Next scan: inspector must NOT re-flag the same pair
    expect(similarAccountsInspector.inspect(db, { fileIds: [file] })).toEqual([]);
  });
});

describe("runInspectors", () => {
  it("walks every inspector and persists their unknowns", () => {
    const db = freshDb();
    const file = makeScannedFile(db, "sf:1");
    recordTransaction(db, {
      source_file_id: file,
      date: "2026-02-01",
      description: "Same",
      postings: [{ account_id: "expense:food", debit: 50 }, { account_id: "asset:kbank", credit: 50 }],
    });
    recordTransaction(db, {
      source_file_id: file,
      date: "2026-02-02",
      description: "Same again",
      postings: [{ account_id: "expense:food", debit: 50 }, { account_id: "asset:kbank", credit: 50 }],
    });
    const result = runInspectors(db, { fileIds: [file] });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.byInspector.duplicates).toBeGreaterThanOrEqual(1);
    expect(listOpenUnknowns(db, 100).length).toBeGreaterThanOrEqual(1);
  });

  it("emits no unknowns when fileIds is empty", () => {
    const db = freshDb();
    const result = runInspectors(db, { fileIds: [] });
    expect(result.total).toBe(0);
    expect(listOpenUnknownsByKind(db, ["duplicate", "correlation", "recurrence_candidate", "similar_accounts"])).toEqual([]);
  });
});
