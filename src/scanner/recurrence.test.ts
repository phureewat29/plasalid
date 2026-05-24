import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { recordTransaction } from "../db/queries/transactions.js";
import {
  findRecurrenceCandidates,
  recordRecurrence,
} from "../db/queries/recurrences.js";
import { upsertRule } from "../db/queries/rules.js";
import { recordQuestion, listQuestions } from "../db/queries/questions.js";
import {
  applyRecurrenceRules,
  generateRecurrenceCandidateQuestions,
  recurrenceCandidateKey,
} from "./recurrence.js";

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
  return new Date(Date.parse(start) + days * 86_400_000).toISOString().slice(0, 10);
}

function seedSeries(
  db: Database.Database,
  opts: { amount: number; description: string; startDate: string; gapDays: number; count: number },
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < opts.count; i++) {
    const id = recordTransaction(db, {
      date: isoPlus(opts.startDate, opts.gapDays * i),
      description: opts.description,
      postings: [
        { account_id: "expense:subs", debit: opts.amount },
        { account_id: "liability:ktc", credit: opts.amount },
      ],
    });
    ids.push(id);
  }
  return ids;
}

const SPOTIFY_KEY = recurrenceCandidateKey("expense:subs", 19900, "THB", "debit");

describe("recurrence", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("returns 0 on an empty DB", () => {
    expect(generateRecurrenceCandidateQuestions(db, null)).toBe(0);
    expect(applyRecurrenceRules(db).linked).toBe(0);
    expect(listQuestions(db).length).toBe(0);
  });

  it("creates one question for a 3x monthly bucket with no covering rule", () => {
    seedSeries(db, { amount: 199, description: "Spotify", startDate: "2026-01-01", gapDays: 30, count: 3 });

    const created = generateRecurrenceCandidateQuestions(db, "sc:test");
    expect(created).toBe(1);

    const [q] = listQuestions(db);
    expect(q.kind).toBe("recurrence_candidate");
    expect(q.scan_id).toBe("sc:test");
    expect(q.account_id).toBe("expense:subs");
    const ctx = JSON.parse(q.context_json!);
    expect(ctx.rule_key).toBe(SPOTIFY_KEY);
    expect(ctx.implied_frequency).toBe("monthly");
    expect(ctx.transaction_ids).toHaveLength(3);
    expect(JSON.parse(q.options_json!)).toEqual(["Link as recurring", "Not recurring", "Skip"]);
  });

  it("does not create a second question on a repeat call", () => {
    seedSeries(db, { amount: 199, description: "Spotify", startDate: "2026-01-01", gapDays: 30, count: 3 });
    generateRecurrenceCandidateQuestions(db, null);
    const second = generateRecurrenceCandidateQuestions(db, null);
    expect(second).toBe(0);
    expect(listQuestions(db)).toHaveLength(1);
  });

  it("skips a bucket already covered by a \"Not recurring\" rule", () => {
    seedSeries(db, { amount: 199, description: "Spotify", startDate: "2026-01-01", gapDays: 30, count: 3 });
    upsertRule(db, { kind: "recurrence_candidate", key: SPOTIFY_KEY, target: "Not recurring" });

    expect(generateRecurrenceCandidateQuestions(db, null)).toBe(0);
    expect(listQuestions(db)).toHaveLength(0);
  });

  it("applyRecurrenceRules links matching unlinked transactions to the existing recurrences row", () => {
    const initialIds = seedSeries(db, { amount: 199, description: "Spotify", startDate: "2026-01-01", gapDays: 30, count: 3 });
    recordRecurrence(db, {
      account_id: "expense:subs",
      description: "Spotify subscription",
      frequency: "monthly",
      amount_typical: 199,
      currency: "THB",
      transaction_ids: initialIds,
    });
    upsertRule(db, { kind: "recurrence_candidate", key: SPOTIFY_KEY, target: "Link as recurring" });

    const newIds = seedSeries(db, { amount: 199, description: "Spotify", startDate: "2026-04-01", gapDays: 30, count: 2 });

    const result = applyRecurrenceRules(db);
    expect(result.linked).toBe(2);

    for (const id of newIds) {
      const row = db.prepare(`SELECT recurrence_id FROM transactions WHERE id = ?`).get(id) as { recurrence_id: string | null };
      expect(row.recurrence_id).toMatch(/^rc:/);
    }

    expect(generateRecurrenceCandidateQuestions(db, null)).toBe(0);
  });

  it("applyRecurrenceRules is a silent no-op when the rule has no matching recurrences row", () => {
    seedSeries(db, { amount: 199, description: "Spotify", startDate: "2026-01-01", gapDays: 30, count: 3 });
    upsertRule(db, { kind: "recurrence_candidate", key: SPOTIFY_KEY, target: "Link as recurring" });

    const result = applyRecurrenceRules(db);
    expect(result.linked).toBe(0);
  });

  it("excludes already-linked transactions from the heuristic", () => {
    const ids = seedSeries(db, { amount: 199, description: "Spotify", startDate: "2026-01-01", gapDays: 30, count: 3 });
    recordRecurrence(db, {
      account_id: "expense:subs",
      description: "Spotify",
      frequency: "monthly",
      amount_typical: 199,
      currency: "THB",
      transaction_ids: ids,
    });

    expect(findRecurrenceCandidates(db).length).toBe(0);
    expect(generateRecurrenceCandidateQuestions(db, null)).toBe(0);
  });

  it("does not create a question for an irregular cadence", () => {
    recordTransaction(db, { date: "2026-01-01", description: "x", postings: [
      { account_id: "expense:subs", debit: 199 }, { account_id: "liability:ktc", credit: 199 },
    ]});
    recordTransaction(db, { date: "2026-01-06", description: "x", postings: [
      { account_id: "expense:subs", debit: 199 }, { account_id: "liability:ktc", credit: 199 },
    ]});
    recordTransaction(db, { date: "2026-02-12", description: "x", postings: [
      { account_id: "expense:subs", debit: 199 }, { account_id: "liability:ktc", credit: 199 },
    ]});

    expect(generateRecurrenceCandidateQuestions(db, null)).toBe(0);
  });

  it("dedupes against an already-open question with the same rule_key", () => {
    seedSeries(db, { amount: 199, description: "Spotify", startDate: "2026-01-01", gapDays: 30, count: 3 });
    recordQuestion(db, {
      transaction_id: null, account_id: "expense:subs", file_id: null,
      kind: "recurrence_candidate",
      prompt: "preexisting",
      context: { rule_key: SPOTIFY_KEY },
    });

    expect(generateRecurrenceCandidateQuestions(db, null)).toBe(0);
    expect(listQuestions(db)).toHaveLength(1);
  });
});
