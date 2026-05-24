import type Database from "libsql";
import {
  findRecurrenceCandidates,
  linkTransactionToRecurrence,
  type RecurrenceCandidate,
} from "../db/queries/recurrences.js";
import { recordQuestion } from "../db/queries/questions.js";
import { formatAmount } from "../currency.js";

/**
 * Structural key for a recurring-payment bucket. Same key across runs means
 * the same (account, amount, currency, side) signature — the unit on which
 * we learn "yes this recurs" / "no this doesn't" decisions.
 *
 * Embeds amount-in-cents because the recurrence identity *is* the amount:
 * ฿199 monthly ≠ ฿299 monthly. The "no amounts in dedup keys" rule applies
 * to merchant-category rules where amount varies; here it is intrinsic.
 */
export function recurrenceCandidateKey(
  accountId: string,
  amountCents: number,
  currency: string,
  side: "debit" | "credit",
): string {
  return `recurrence:${accountId}:${currency}:${amountCents}:${side}`;
}

const RULE_KIND = "recurrence_candidate";
const ANSWER_LINK = "Link as recurring";

/**
 * Fast path. For every learned "Link as recurring" rule, attach any matching
 * unlinked transaction to the existing recurrences row. One rules-table
 * lookup and one recurrences-table lookup per `(account, currency, amount)`
 * bucket — never re-runs the heuristic.
 */
export function applyRecurrenceRules(db: Database.Database): { linked: number } {
  const rules = db.prepare(
    `SELECT key FROM rules WHERE kind = ? AND target = ?`,
  ).all(RULE_KIND, ANSWER_LINK) as { key: string }[];
  if (rules.length === 0) return { linked: 0 };

  const unlinkedByKey = new Map<string, { transaction_id: string; account_id: string; currency: string; amount: number }[]>();
  const rows = db.prepare(
    `SELECT p.transaction_id,
            p.account_id,
            p.currency,
            CASE WHEN p.debit > 0 THEN p.debit ELSE p.credit END AS amount,
            CASE WHEN p.debit > 0 THEN 'debit' ELSE 'credit' END AS side
     FROM postings p
     JOIN transactions t ON t.id = p.transaction_id
     WHERE t.recurrence_id IS NULL
       AND (p.debit > 0 OR p.credit > 0)`,
  ).all() as { transaction_id: string; account_id: string; currency: string; amount: number; side: "debit" | "credit" }[];

  for (const r of rows) {
    const key = recurrenceCandidateKey(r.account_id, Math.round(r.amount * 100), r.currency, r.side);
    const bucket = unlinkedByKey.get(key) ?? [];
    bucket.push(r);
    unlinkedByKey.set(key, bucket);
  }

  let linked = 0;
  for (const { key } of rules) {
    const bucket = unlinkedByKey.get(key);
    if (!bucket || bucket.length === 0) continue;
    const first = bucket[0];
    const recurrence = db.prepare(
      `SELECT id FROM recurrences WHERE account_id = ? AND currency = ? AND amount_typical = ? LIMIT 1`,
    ).get(first.account_id, first.currency, Math.round(first.amount * 100) / 100) as { id: string } | undefined;
    if (!recurrence) continue; // rule learned but aggregate row gone — let the heuristic re-surface
    for (const r of bucket) {
      linkTransactionToRecurrence(db, r.transaction_id, recurrence.id);
      linked++;
    }
  }
  return { linked };
}

/**
 * Slow path. Runs the heuristic, drops irregular cadences, and skips any
 * bucket already covered by a rule (either decision — "Link" or "Not
 * recurring" both mean "don't ask again") or by an already-open question
 * with the same key. Each survivor becomes one `recurrence_candidate`
 * question that flows through the existing clarifier pipeline.
 */
export function generateRecurrenceCandidateQuestions(
  db: Database.Database,
  scanId: string | null,
): number {
  const coveredKeys = collectCoveredKeys(db);
  const raw = findRecurrenceCandidates(db).filter(
    (c) => c.implied_frequency !== "irregular",
  );
  const candidates = dedupeByTransactionSet(raw);

  let created = 0;
  for (const c of candidates) {
    const amountCents = Math.round(c.amount * 100);
    const side = c.side;
    const key = recurrenceCandidateKey(c.account_id, amountCents, c.currency, side);
    if (coveredKeys.has(key)) continue;
    recordQuestion(db, {
      transaction_id: null,
      account_id: c.account_id,
      file_id: null,
      scan_id: scanId,
      kind: RULE_KIND,
      prompt: buildPrompt(c),
      options: ["Link as recurring", "Not recurring", "Skip"],
      context: {
        rule_key: key,
        account_id: c.account_id,
        amount: c.amount,
        currency: c.currency,
        side: c.side,
        transaction_ids: c.transactions.map((t) => t.id),
        median_days_between: c.median_days_between,
        implied_frequency: c.implied_frequency,
      },
    });
    coveredKeys.add(key); // avoid duplicate inserts within this same call
    created++;
  }
  return created;
}

function collectCoveredKeys(db: Database.Database): Set<string> {
  const ruleKeys = db.prepare(
    `SELECT key FROM rules WHERE kind = ?`,
  ).all(RULE_KIND) as { key: string }[];
  const openQuestions = db.prepare(
    `SELECT context_json FROM questions WHERE kind = ?`,
  ).all(RULE_KIND) as { context_json: string | null }[];
  const keys = new Set<string>(ruleKeys.map((r) => r.key));
  for (const q of openQuestions) {
    if (!q.context_json) continue;
    try {
      const parsed = JSON.parse(q.context_json);
      if (typeof parsed?.rule_key === "string") keys.add(parsed.rule_key);
    } catch {
      // malformed context — ignore; the question already exists, generation
      // wouldn't dedupe it anyway, so the worst case is a duplicate.
    }
  }
  return keys;
}

/**
 * A single recurring event lands as two posting buckets — the expense/income
 * leg and the asset/liability leg of the same N transactions. Collapse to
 * one prompt per event, preferring the leg the user actually thinks about
 * (expense > income > liability > asset > equity).
 */
function dedupeByTransactionSet(candidates: RecurrenceCandidate[]): RecurrenceCandidate[] {
  const byTxSig = new Map<string, RecurrenceCandidate[]>();
  for (const c of candidates) {
    const sig = c.transactions.map((t) => t.id).sort().join(",");
    const arr = byTxSig.get(sig) ?? [];
    arr.push(c);
    byTxSig.set(sig, arr);
  }
  const out: RecurrenceCandidate[] = [];
  for (const group of byTxSig.values()) {
    group.sort((a, b) =>
      typeRank(a.account_id) - typeRank(b.account_id) ||
      a.account_id.localeCompare(b.account_id),
    );
    out.push(group[0]);
  }
  return out;
}

const TYPE_PRIORITY: Record<string, number> = {
  expense: 0, income: 1, liability: 2, asset: 3, equity: 4,
};
function typeRank(accountId: string): number {
  return TYPE_PRIORITY[accountId.split(":")[0]] ?? 99;
}

function buildPrompt(c: RecurrenceCandidate): string {
  const amountStr = formatAmount(c.amount, c.currency);
  const sideLabel = c.side === "debit" ? "outflow" : "inflow";
  return (
    `${c.transactions.length} ${sideLabel}s on \`${c.account_id}\` of ${amountStr} ` +
    `every ~${c.median_days_between} days (looks ${c.implied_frequency}). ` +
    `Link them as a recurring item?`
  );
}
