import type Database from "libsql";
import { randomUUID } from "crypto";
import { dayDiff } from "./journal.js";

export type RecurrenceFrequency = "weekly" | "biweekly" | "monthly" | "annually";

export interface RecurrenceCandidate {
  account_id: string;
  account_name: string;
  amount: number;
  currency: string;
  side: "debit" | "credit";
  entries: { id: string; date: string; description: string }[];
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

  const accountFilter = opts.accountId ? `AND jl.account_id = ?` : ``;
  const params: any[] = opts.accountId ? [opts.accountId] : [];

  const rows = db.prepare(
    `SELECT jl.account_id,
            a.name AS account_name,
            jl.currency,
            CASE WHEN jl.debit > 0 THEN jl.debit ELSE jl.credit END AS amount,
            CASE WHEN jl.debit > 0 THEN 'debit' ELSE 'credit' END AS side,
            je.id AS entry_id,
            je.date,
            je.description
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.entry_id
     JOIN accounts a ON a.id = jl.account_id
     WHERE je.recurrence_id IS NULL
       AND (jl.debit > 0 OR jl.credit > 0)
       ${accountFilter}
     ORDER BY jl.account_id, jl.currency, amount, je.date`,
  ).all(...params) as {
    account_id: string;
    account_name: string;
    currency: string;
    amount: number;
    side: "debit" | "credit";
    entry_id: string;
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
      entries: bucket.map(r => ({ id: r.entry_id, date: r.date, description: r.description })),
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

// ── Persistence ─────────────────────────────────────────────────────────────

export interface RecordRecurrenceInput {
  account_id: string;
  description: string;
  frequency: RecurrenceFrequency;
  amount_typical?: number | null;
  currency?: string;
  entry_ids: string[];
  notes?: string | null;
}

const FREQ_PERIOD_DAYS: Record<RecurrenceFrequency, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  annually: 365,
};

export function recordRecurrence(db: Database.Database, input: RecordRecurrenceInput): string {
  if (!input.entry_ids || input.entry_ids.length === 0) {
    throw new Error("recordRecurrence requires at least one entry_id.");
  }

  const placeholders = input.entry_ids.map(() => "?").join(",");
  const dateRows = db.prepare(
    `SELECT date FROM journal_entries WHERE id IN (${placeholders}) ORDER BY date ASC`,
  ).all(...input.entry_ids) as { date: string }[];

  if (dateRows.length === 0) {
    throw new Error("None of the supplied entry_ids exist.");
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
    const updateEntry = db.prepare(`UPDATE journal_entries SET recurrence_id = ? WHERE id = ?`);
    for (const entryId of input.entry_ids) updateEntry.run(id, entryId);
  });
  tx();
  return id;
}

export function linkEntryToRecurrence(
  db: Database.Database,
  entryId: string,
  recurrenceId: string,
): void {
  const recurrence = db
    .prepare(`SELECT frequency FROM recurrences WHERE id = ?`)
    .get(recurrenceId) as { frequency: RecurrenceFrequency } | undefined;
  if (!recurrence) throw new Error(`Recurrence ${recurrenceId} not found.`);

  const entry = db
    .prepare(`SELECT date FROM journal_entries WHERE id = ?`)
    .get(entryId) as { date: string } | undefined;
  if (!entry) throw new Error(`Entry ${entryId} not found.`);

  const tx = db.transaction((): void => {
    db.prepare(`UPDATE journal_entries SET recurrence_id = ? WHERE id = ?`).run(recurrenceId, entryId);
    // Recompute first/last/next from the full member set so the recurrence
    // metadata stays in sync after every attach.
    const span = db
      .prepare(`SELECT MIN(date) AS first, MAX(date) AS last FROM journal_entries WHERE recurrence_id = ?`)
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
