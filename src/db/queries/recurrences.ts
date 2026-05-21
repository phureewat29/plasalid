import type Database from "libsql";
import { randomUUID } from "crypto";
import { dayDiff } from "./transactions.js";

export type RecurrenceFrequency = "weekly" | "biweekly" | "monthly" | "annually";

export interface RecurrenceCandidate {
  account_id: string;
  account_name: string;
  amount: number;
  currency: string;
  side: "debit" | "credit";
  transactions: { id: string; date: string; description: string }[];
  median_days_between: number;
  implied_frequency: RecurrenceFrequency | "irregular";
}

export interface FindRecurrencesOptions {
  accountId?: string;
  /** Minimum sightings to qualify. Default 3. */
  minOccurrences?: number;
}

export function findRecurrenceCandidates(
  db: Database.Database,
  opts: FindRecurrencesOptions = {},
): RecurrenceCandidate[] {
  const minOccurrences = Math.max(2, opts.minOccurrences ?? 3);

  const accountFilter = opts.accountId ? `AND p.account_id = ?` : ``;
  const params: any[] = opts.accountId ? [opts.accountId] : [];

  const rows = db.prepare(
    `SELECT p.account_id,
            a.name AS account_name,
            p.currency,
            CASE WHEN p.debit > 0 THEN p.debit ELSE p.credit END AS amount,
            CASE WHEN p.debit > 0 THEN 'debit' ELSE 'credit' END AS side,
            t.id AS transaction_id,
            t.date,
            t.description
     FROM postings p
     JOIN transactions t ON t.id = p.transaction_id
     JOIN accounts a ON a.id = p.account_id
     WHERE t.recurrence_id IS NULL
       AND (p.debit > 0 OR p.credit > 0)
       ${accountFilter}
     ORDER BY p.account_id, p.currency, amount, t.date`,
  ).all(...params) as {
    account_id: string;
    account_name: string;
    currency: string;
    amount: number;
    side: "debit" | "credit";
    transaction_id: string;
    date: string;
    description: string;
  }[];

  const buckets = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.account_id}|${r.currency}|${Math.round(r.amount * 100)}|${r.side}`;
    const arr = buckets.get(key) ?? [];
    arr.push(r);
    buckets.set(key, arr);
  }

  const candidates: RecurrenceCandidate[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < minOccurrences) continue;
    const dates = bucket.map(r => r.date);
    const diffs: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      diffs.push(dayDiff(dates[i - 1], dates[i]));
    }
    const median = medianOf(diffs);
    candidates.push({
      account_id: bucket[0].account_id,
      account_name: bucket[0].account_name,
      amount: Math.round(bucket[0].amount * 100) / 100,
      currency: bucket[0].currency,
      side: bucket[0].side,
      transactions: bucket.map(r => ({ id: r.transaction_id, date: r.date, description: r.description })),
      median_days_between: median,
      implied_frequency: classifyFrequency(median),
    });
  }
  return candidates;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function classifyFrequency(medianDays: number): RecurrenceFrequency | "irregular" {
  if (medianDays >= 6  && medianDays <= 8)   return "weekly";
  if (medianDays >= 13 && medianDays <= 15)  return "biweekly";
  if (medianDays >= 27 && medianDays <= 32)  return "monthly";
  if (medianDays >= 360 && medianDays <= 370) return "annually";
  return "irregular";
}

export interface RecordRecurrenceInput {
  account_id: string;
  description: string;
  frequency: RecurrenceFrequency;
  amount_typical?: number | null;
  currency?: string;
  transaction_ids: string[];
  notes?: string | null;
}

const FREQ_PERIOD_DAYS: Record<RecurrenceFrequency, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  annually: 365,
};

export function recordRecurrence(db: Database.Database, input: RecordRecurrenceInput): string {
  if (!input.transaction_ids || input.transaction_ids.length === 0) {
    throw new Error("recordRecurrence requires at least one transaction_id.");
  }

  const placeholders = input.transaction_ids.map(() => "?").join(",");
  const dateRows = db.prepare(
    `SELECT date FROM transactions WHERE id IN (${placeholders}) ORDER BY date ASC`,
  ).all(...input.transaction_ids) as { date: string }[];

  if (dateRows.length === 0) {
    throw new Error("None of the supplied transaction_ids exist.");
  }

  const firstSeen = dateRows[0].date;
  const lastSeen = dateRows[dateRows.length - 1].date;
  const nextExpected = addDays(lastSeen, FREQ_PERIOD_DAYS[input.frequency]);

  const id = `rc:${randomUUID()}`;
  const tx = db.transaction((): void => {
    db.prepare(
      `INSERT INTO recurrences
         (id, account_id, description, frequency, amount_typical, currency,
          first_seen_date, last_seen_date, next_expected_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.account_id,
      input.description,
      input.frequency,
      input.amount_typical ?? null,
      input.currency || "THB",
      firstSeen,
      lastSeen,
      nextExpected,
      input.notes ?? null,
    );
    const updateTx = db.prepare(`UPDATE transactions SET recurrence_id = ? WHERE id = ?`);
    for (const transactionId of input.transaction_ids) updateTx.run(id, transactionId);
  });
  tx();
  return id;
}

export function linkTransactionToRecurrence(
  db: Database.Database,
  transactionId: string,
  recurrenceId: string,
): void {
  const recurrence = db
    .prepare(`SELECT frequency FROM recurrences WHERE id = ?`)
    .get(recurrenceId) as { frequency: RecurrenceFrequency } | undefined;
  if (!recurrence) throw new Error(`Recurrence ${recurrenceId} not found.`);

  const transaction = db
    .prepare(`SELECT date FROM transactions WHERE id = ?`)
    .get(transactionId) as { date: string } | undefined;
  if (!transaction) throw new Error(`Transaction ${transactionId} not found.`);

  const tx = db.transaction((): void => {
    db.prepare(`UPDATE transactions SET recurrence_id = ? WHERE id = ?`).run(recurrenceId, transactionId);
    const span = db
      .prepare(`SELECT MIN(date) AS first, MAX(date) AS last FROM transactions WHERE recurrence_id = ?`)
      .get(recurrenceId) as { first: string; last: string };
    const nextExpected = addDays(span.last, FREQ_PERIOD_DAYS[recurrence.frequency]);
    db.prepare(
      `UPDATE recurrences SET first_seen_date = ?, last_seen_date = ?, next_expected_date = ? WHERE id = ?`,
    ).run(span.first, span.last, nextExpected, recurrenceId);
  });
  tx();
}

function addDays(dateIso: string, days: number): string {
  const t = Date.parse(dateIso);
  if (Number.isNaN(t)) return dateIso;
  const next = new Date(t + days * 86_400_000);
  return next.toISOString().slice(0, 10);
}

export interface RecurringSummary {
  count: number;
  /** Sum of every recurrence's amount_typical normalized to a monthly cadence.
   *  Excludes rows whose amount is null (system can't estimate without one). */
  monthly_estimate: number;
}

const MONTHLY_MULTIPLIER: Record<RecurrenceFrequency, number> = {
  weekly:   52 / 12,
  biweekly: 26 / 12,
  monthly:  1,
  annually: 1 / 12,
};

export function getRecurringSummary(db: Database.Database): RecurringSummary {
  const rows = db
    .prepare(`SELECT frequency, amount_typical FROM recurrences`)
    .all() as { frequency: RecurrenceFrequency; amount_typical: number | null }[];

  let monthly = 0;
  for (const r of rows) {
    if (r.amount_typical == null) continue;
    const mult = MONTHLY_MULTIPLIER[r.frequency];
    if (mult == null) continue;
    monthly += r.amount_typical * mult;
  }
  return { count: rows.length, monthly_estimate: Math.round(monthly * 100) / 100 };
}
