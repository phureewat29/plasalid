import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../schema.js";
import { recordTransaction } from "./transactions.js";
import {
  findRecurrenceCandidates,
  recordRecurrence,
  linkTransactionToRecurrence,
} from "./recurrences.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  for (const [id, name, type] of [
    ["asset", "Assets", "asset"],
    ["liability", "Liabilities", "liability"],
    ["expense", "Expenses", "expense"],
  ] as const) {
    db.prepare(`INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)`).run(id, name, type);
  }
  db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`)
    .run("liability:ktc", "KTC Card", "liability", "liability");
  db.prepare(`INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)`)
    .run("expense:subs", "Subscriptions", "expense", "expense");
  return db;
}

function isoPlus(start: string, days: number): string {
  const t = Date.parse(start);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

function seedSeries(
  db: Database.Database,
  opts: { amount: number; description: string; startDate: string; gapDays: number; count: number },
): void {
  for (let i = 0; i < opts.count; i++) {
    recordTransaction(db, {
      date: isoPlus(opts.startDate, opts.gapDays * i),
      description: opts.description,
      postings: [
        { account_id: "expense:subs", debit: opts.amount },
        { account_id: "liability:ktc", credit: opts.amount },
      ],
    });
  }
}

describe("findRecurrenceCandidates → classifyFrequency", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it.each([
    { gapDays: 7,   expected: "weekly" },
    { gapDays: 14,  expected: "biweekly" },
    { gapDays: 30,  expected: "monthly" },
    { gapDays: 365, expected: "annually" },
    { gapDays: 21,  expected: "irregular" },
  ])("classifies a $gapDays-day cadence as $expected", ({ gapDays, expected }) => {
    seedSeries(db, {
      amount: 199,
      description: `${gapDays}-day cadence`,
      startDate: "2026-01-01",
      gapDays,
      count: 4,
    });
    const [match] = findRecurrenceCandidates(db, { accountId: "expense:subs" });
    expect(match).toBeDefined();
    expect(match.implied_frequency).toBe(expected);
    expect(match.median_days_between).toBe(gapDays);
    expect(match.transactions).toHaveLength(4);
  });

  it("ignores series below the minOccurrences threshold (default 3)", () => {
    seedSeries(db, {
      amount: 99,
      description: "twice-only",
      startDate: "2026-01-01",
      gapDays: 7,
      count: 2,
    });
    expect(findRecurrenceCandidates(db, { accountId: "expense:subs" })).toHaveLength(0);
  });

  it("respects an explicit minOccurrences (one bucket per side)", () => {
    seedSeries(db, {
      amount: 99,
      description: "pair",
      startDate: "2026-01-01",
      gapDays: 7,
      count: 2,
    });
    // Two postings per transaction (debit on expense, credit on liability) →
    // two buckets that each qualify at minOccurrences=2.
    expect(findRecurrenceCandidates(db, { minOccurrences: 2 })).toHaveLength(2);
    expect(findRecurrenceCandidates(db, { minOccurrences: 2, accountId: "expense:subs" })).toHaveLength(1);
  });

  it("buckets independently by account+currency+amount+side", () => {
    seedSeries(db, { amount: 199, description: "Spotify",  startDate: "2026-01-01", gapDays: 30, count: 4 });
    seedSeries(db, { amount: 419, description: "Netflix",  startDate: "2026-01-02", gapDays: 30, count: 4 });
    // Scoped to the expense side: one bucket per merchant amount.
    const expenseSide = findRecurrenceCandidates(db, { accountId: "expense:subs" });
    expect(expenseSide).toHaveLength(2);
    const amounts = expenseSide.map(c => c.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([199, 419]);
  });

  it("excludes transactions already linked to a recurrence", () => {
    seedSeries(db, { amount: 199, description: "Spotify", startDate: "2026-01-01", gapDays: 30, count: 4 });
    const [first] = findRecurrenceCandidates(db, { accountId: "expense:subs" });
    const recId = recordRecurrence(db, {
      account_id: "expense:subs",
      description: "Spotify",
      frequency: "monthly",
      transaction_ids: first.transactions.map(t => t.id),
    });
    expect(recId).toMatch(/^rc:/);
    expect(findRecurrenceCandidates(db, { accountId: "expense:subs" })).toHaveLength(0);
  });
});

describe("classifyFrequency boundary cases", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("treats a 6-day median as weekly (lower bound)", () => {
    seedSeries(db, { amount: 50, description: "six-day", startDate: "2026-01-01", gapDays: 6, count: 4 });
    const [c] = findRecurrenceCandidates(db, { accountId: "expense:subs" });
    expect(c.implied_frequency).toBe("weekly");
  });

  it("treats a 32-day median as monthly (upper bound)", () => {
    seedSeries(db, { amount: 50, description: "thirty-two", startDate: "2026-01-01", gapDays: 32, count: 4 });
    const [c] = findRecurrenceCandidates(db, { accountId: "expense:subs" });
    expect(c.implied_frequency).toBe("monthly");
  });

  it("treats a 33-day median as irregular (just outside monthly)", () => {
    seedSeries(db, { amount: 50, description: "thirty-three", startDate: "2026-01-01", gapDays: 33, count: 4 });
    const [c] = findRecurrenceCandidates(db, { accountId: "expense:subs" });
    expect(c.implied_frequency).toBe("irregular");
  });
});

describe("recordRecurrence + linkTransactionToRecurrence", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("records a recurrence and links all supplied transactions", () => {
    seedSeries(db, { amount: 199, description: "Spotify", startDate: "2026-01-01", gapDays: 30, count: 3 });
    const [c] = findRecurrenceCandidates(db, { accountId: "expense:subs" });
    const txIds = c.transactions.map(t => t.id);
    const recId = recordRecurrence(db, {
      account_id: "expense:subs",
      description: "Spotify",
      frequency: "monthly",
      transaction_ids: txIds,
    });
    const linked = db.prepare(`SELECT id FROM transactions WHERE recurrence_id = ?`).all(recId) as { id: string }[];
    expect(linked.map(r => r.id).sort()).toEqual(txIds.sort());
    const rec = db.prepare(`SELECT first_seen_date, last_seen_date, next_expected_date FROM recurrences WHERE id = ?`)
      .get(recId) as { first_seen_date: string; last_seen_date: string; next_expected_date: string };
    expect(rec.first_seen_date).toBe("2026-01-01");
    expect(rec.last_seen_date).toBe("2026-03-02"); // start + 60 days
    expect(rec.next_expected_date).toBe(isoPlus(rec.last_seen_date, 30));
  });

  it("throws when no transaction ids are supplied", () => {
    expect(() =>
      recordRecurrence(db, {
        account_id: "expense:subs",
        description: "ghost",
        frequency: "monthly",
        transaction_ids: [],
      }),
    ).toThrow(/at least one/i);
  });

  it("linkTransactionToRecurrence extends the recurrence span", () => {
    seedSeries(db, { amount: 199, description: "Spotify", startDate: "2026-01-01", gapDays: 30, count: 3 });
    const [c] = findRecurrenceCandidates(db, { accountId: "expense:subs" });
    const recId = recordRecurrence(db, {
      account_id: "expense:subs",
      description: "Spotify",
      frequency: "monthly",
      transaction_ids: c.transactions.slice(0, 2).map(t => t.id),
    });
    linkTransactionToRecurrence(db, c.transactions[2].id, recId);
    const rec = db.prepare(`SELECT last_seen_date, next_expected_date FROM recurrences WHERE id = ?`)
      .get(recId) as { last_seen_date: string; next_expected_date: string };
    expect(rec.last_seen_date).toBe(c.transactions[2].date);
    expect(rec.next_expected_date).toBe(isoPlus(rec.last_seen_date, 30));
  });
});
