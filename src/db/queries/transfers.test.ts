import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import { createAccount } from "./account-balance.js";
import {
  validateTransfer,
  deriveTransferId,
  deriveGroupId,
  insertTransfer,
  insertLinkedTransfers,
  getTransfer,
  listTransfers,
  deleteTransfer,
  bulkRecategorize,
  findDuplicateTransfers,
  findCorrelatedTransfers,
  countTransfers,
  countTransfersBySourceFile,
  updateTransferMeta,
  type TransferInput,
} from "./transfers.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "asset", name: "Assets", type: "asset", parent_id: null });
  createAccount(db, { id: "asset:cash", name: "Cash", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "asset:bank", name: "KBank Savings", type: "asset", parent_id: "asset" });
  createAccount(db, { id: "expense", name: "Expenses", type: "expense", parent_id: null });
  createAccount(db, { id: "expense:food", name: "Food", type: "expense", parent_id: "expense" });
  createAccount(db, { id: "expense:transport", name: "Transport", type: "expense", parent_id: "expense" });
  return db;
}

function tf(over: Partial<TransferInput> = {}): TransferInput {
  return {
    date: "2026-05-01",
    description: "Coffee",
    debit_account_id: "expense:food",
    credit_account_id: "asset:cash",
    amount: 15000,
    currency: "THB",
    ...over,
  };
}

describe("validateTransfer", () => {
  it("accepts a well-formed transfer", () => {
    expect(validateTransfer(tf())).toEqual({ ok: true });
  });

  it("rejects a non-ISO date", () => {
    expect(validateTransfer(tf({ date: "2026/05/01" }))).toMatchObject({ ok: false });
    expect(validateTransfer(tf({ date: "" }))).toMatchObject({ ok: false });
  });

  it("rejects an empty description", () => {
    expect(validateTransfer(tf({ description: "  " }))).toMatchObject({ ok: false });
  });

  it("rejects a non-integer or non-positive amount", () => {
    expect(validateTransfer(tf({ amount: 1.5 }))).toMatchObject({ ok: false });
    expect(validateTransfer(tf({ amount: 0 }))).toMatchObject({ ok: false });
    expect(validateTransfer(tf({ amount: -100 }))).toMatchObject({ ok: false });
  });

  it("rejects empty account ids and debit == credit", () => {
    expect(validateTransfer(tf({ debit_account_id: "" }))).toMatchObject({ ok: false });
    expect(validateTransfer(tf({ credit_account_id: "" }))).toMatchObject({ ok: false });
    expect(validateTransfer(tf({ debit_account_id: "asset:cash", credit_account_id: "asset:cash" }))).toMatchObject({
      ok: false,
    });
  });
});

describe("deriveTransferId / deriveGroupId", () => {
  it("is deterministic", () => {
    expect(deriveTransferId("hashX", 1, 0)).toBe(deriveTransferId("hashX", 1, 0));
  });

  it("varies by row index and leg index", () => {
    expect(deriveTransferId("hashX", 1, 0)).not.toBe(deriveTransferId("hashX", 1, 1));
    expect(deriveTransferId("hashX", 1, 0)).not.toBe(deriveTransferId("hashX", 1, 0, 0));
    expect(deriveTransferId("hashX", 1, 0, 0)).not.toBe(deriveTransferId("hashX", 1, 0, 1));
  });

  it("prefixes tf: / tg: and shares the hash between the legless id and the group id", () => {
    const tfid = deriveTransferId("hashX", 1, 0);
    const gid = deriveGroupId("hashX", 1, 0);
    expect(tfid.startsWith("tf:")).toBe(true);
    expect(gid.startsWith("tg:")).toBe(true);
    expect(tfid.slice(3)).toBe(gid.slice(3));
  });
});

describe("insertTransfer", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("inserts once and reports duplicate on the same id", () => {
    expect(insertTransfer(db, tf({ id: "tf:fixed" }))).toEqual({ id: "tf:fixed", duplicate: false });
    expect(insertTransfer(db, tf({ id: "tf:fixed" }))).toEqual({ id: "tf:fixed", duplicate: true });
    expect(countTransfers(db)).toBe(1);
  });

  it("throws on invalid input", () => {
    expect(() => insertTransfer(db, tf({ amount: 0 }))).toThrow();
  });

  it("upserts a merchant when supplied", () => {
    insertTransfer(db, tf({ id: "tf:mc", merchant: { canonical_name: "Starbucks" } }));
    expect(getTransfer(db, "tf:mc")?.merchant_name).toBe("Starbucks");
  });
});

describe("insertLinkedTransfers", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("shares one group id across every leg", () => {
    const res = insertLinkedTransfers(db, [
      tf({ id: "tf:a" }),
      tf({ id: "tf:b", debit_account_id: "expense:transport" }),
    ]);
    expect(res.results.map((r) => r.id)).toEqual(["tf:a", "tf:b"]);
    expect(res.group_id.startsWith("tg:")).toBe(true);
    expect(getTransfer(db, "tf:a")?.group_id).toBe(res.group_id);
    expect(getTransfer(db, "tf:b")?.group_id).toBe(res.group_id);
  });

  it("rolls back every leg when one leg is invalid", () => {
    expect(() =>
      insertLinkedTransfers(db, [
        tf({ id: "tf:a" }),
        tf({ id: "tf:b", debit_account_id: "asset:cash", credit_account_id: "asset:cash" }),
      ]),
    ).toThrow();
    expect(countTransfers(db)).toBe(0);
  });
});

describe("getTransfer", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("returns null for a missing id", () => {
    expect(getTransfer(db, "tf:nope")).toBeNull();
  });

  it("joins account + merchant names and carries the full group", () => {
    const res = insertLinkedTransfers(db, [
      tf({ id: "tf:a" }),
      tf({ id: "tf:b", debit_account_id: "expense:transport" }),
    ]);
    const detail = getTransfer(db, "tf:a")!;
    expect(detail.debit_account_name).toBe("Food");
    expect(detail.credit_account_name).toBe("Cash");
    expect(detail.group_id).toBe(res.group_id);
    expect(detail.group?.map((g) => g.id).sort()).toEqual(["tf:a", "tf:b"]);
  });
});

describe("listTransfers", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    insertTransfer(db, tf({ id: "tf:1", description: "Coffee", debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 15000 }));
    insertTransfer(db, tf({ id: "tf:2", description: "Taxi", debit_account_id: "expense:transport", credit_account_id: "asset:bank", amount: 20000 }));
  });

  it("orders by date DESC, id DESC", () => {
    expect(listTransfers(db).map((r) => r.id)).toEqual(["tf:2", "tf:1"]);
  });

  it("matches an account on EITHER side", () => {
    expect(listTransfers(db, { account: "asset:cash" }).map((r) => r.id)).toEqual(["tf:1"]);
    expect(listTransfers(db, { account: "expense:food" }).map((r) => r.id)).toEqual(["tf:1"]);
    expect(listTransfers(db, { account: "asset:bank" }).map((r) => r.id)).toEqual(["tf:2"]);
  });

  it("queries over description and either account name", () => {
    expect(listTransfers(db, { query: "Taxi" }).map((r) => r.id)).toEqual(["tf:2"]);
    expect(listTransfers(db, { query: "Cash" }).map((r) => r.id)).toEqual(["tf:1"]);
    expect(listTransfers(db, { query: "KBank" }).map((r) => r.id)).toEqual(["tf:2"]);
  });

  it("clusters by group when requested (nulls standalone)", () => {
    const linked = insertLinkedTransfers(db, [
      tf({ id: "tf:g1", amount: 5000 }),
      tf({ id: "tf:g2", debit_account_id: "expense:transport", amount: 5000 }),
    ]);
    const clusters = listTransfers(db, { group: true });
    const grouped = clusters.find((c) => c.group_id === linked.group_id);
    expect(grouped?.transfers.map((t) => t.id).sort()).toEqual(["tf:g1", "tf:g2"]);
    // tf:1 and tf:2 have null group_id => each its own standalone cluster.
    const standalones = clusters.filter((c) => c.group_id === null).flatMap((c) => c.transfers.map((t) => t.id));
    expect(standalones).toContain("tf:1");
    expect(standalones).toContain("tf:2");
  });
});

describe("deleteTransfer", () => {
  it("removes a row and reports success", () => {
    const db = freshDb();
    insertTransfer(db, tf({ id: "tf:1" }));
    expect(deleteTransfer(db, "tf:1")).toBe(true);
    expect(deleteTransfer(db, "tf:1")).toBe(false);
    expect(countTransfers(db)).toBe(0);
  });
});

describe("bulkRecategorize", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    insertTransfer(db, tf({ id: "tf:d", debit_account_id: "expense:food", credit_account_id: "asset:cash" }));
    insertTransfer(db, tf({ id: "tf:c", debit_account_id: "asset:cash", credit_account_id: "expense:food" }));
    insertTransfer(db, tf({ id: "tf:self", debit_account_id: "expense:food", credit_account_id: "expense:transport" }));
  });

  it("moves both sides and skips would-be self-transfers", () => {
    const res = bulkRecategorize(db, { accountId: "expense:food" }, { accountId: "expense:transport" });
    expect(res.affected).toBe(2);
    expect(res.skipped_self_transfer).toBe(1);
    expect(getTransfer(db, "tf:d")?.debit_account_id).toBe("expense:transport");
    expect(getTransfer(db, "tf:c")?.credit_account_id).toBe("expense:transport");
    // The self-transfer candidate is untouched.
    expect(getTransfer(db, "tf:self")?.debit_account_id).toBe("expense:food");
    expect(getTransfer(db, "tf:self")?.credit_account_id).toBe("expense:transport");
  });

  it("throws when the target account does not exist", () => {
    expect(() => bulkRecategorize(db, { accountId: "expense:food" }, { accountId: "expense:nope" })).toThrow(
      /does not exist/,
    );
  });

  it("refuses the no-op where set == filter account", () => {
    expect(() => bulkRecategorize(db, { accountId: "expense:food" }, { accountId: "expense:food" })).toThrow(
      /no-op/,
    );
  });
});

describe("findDuplicateTransfers", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("detects cross-group duplicates but excludes intra-group members", () => {
    // Same amount + same directional pair + same date, but linked in one group.
    insertLinkedTransfers(db, [
      tf({ id: "tf:same1", debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 5000 }),
      tf({ id: "tf:same2", debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 5000 }),
    ]);
    // Two independent transfers that ARE duplicates.
    insertTransfer(db, tf({ id: "tf:dup1", debit_account_id: "expense:transport", credit_account_id: "asset:bank", amount: 7000 }));
    insertTransfer(db, tf({ id: "tf:dup2", debit_account_id: "expense:transport", credit_account_id: "asset:bank", amount: 7000 }));

    const groups = findDuplicateTransfers(db);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((r) => r.id).sort()).toEqual(["tf:dup1", "tf:dup2"]);
  });
});

describe("findCorrelatedTransfers", () => {
  it("pairs same-amount/currency transfers across disjoint account pairs", () => {
    const db = freshDb();
    insertTransfer(db, tf({ id: "tf:x", debit_account_id: "asset:cash", credit_account_id: "asset:bank", amount: 10000, date: "2026-06-01" }));
    insertTransfer(db, tf({ id: "tf:y", debit_account_id: "expense:food", credit_account_id: "expense:transport", amount: 10000, date: "2026-06-02" }));
    const pairs = findCorrelatedTransfers(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].day_gap).toBe(1);
    expect([pairs[0].a.id, pairs[0].b.id].sort()).toEqual(["tf:x", "tf:y"]);
  });

  it("skips overlapping (shared-account) pairs", () => {
    const db = freshDb();
    insertTransfer(db, tf({ id: "tf:x", debit_account_id: "asset:cash", credit_account_id: "asset:bank", amount: 10000, date: "2026-06-01" }));
    insertTransfer(db, tf({ id: "tf:y", debit_account_id: "expense:food", credit_account_id: "asset:cash", amount: 10000, date: "2026-06-02" }));
    expect(findCorrelatedTransfers(db)).toHaveLength(0);
  });
});

describe("counts + updateTransferMeta", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    db.prepare(
      `INSERT INTO scanned_files (id, path, file_hash, mime, status) VALUES ('sf:1','/f.pdf','h1','application/pdf','scanned')`,
    ).run();
  });

  it("counts total and by source file", () => {
    insertTransfer(db, tf({ id: "tf:1", source_file_id: "sf:1" }));
    insertTransfer(db, tf({ id: "tf:2", debit_account_id: "expense:transport" }));
    expect(countTransfers(db)).toBe(2);
    expect(countTransfersBySourceFile(db, "sf:1")).toBe(1);
  });

  it("edits mutable metadata only", () => {
    insertTransfer(db, tf({ id: "tf:m" }));
    expect(updateTransferMeta(db, "tf:m", { description: "Latte", source_page: 3 })).toBe(1);
    const r = getTransfer(db, "tf:m")!;
    expect(r.description).toBe("Latte");
    expect(r.source_page).toBe(3);
    expect(updateTransferMeta(db, "tf:m", {})).toBe(0);
  });
});
