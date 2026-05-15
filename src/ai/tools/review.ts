import type Database from "libsql";
import {
  deleteAccount,
  findSimilarAccounts,
  findUnusedAccounts,
  mergeAccounts,
  renameAccount,
} from "../../db/queries/account_balance.js";
import {
  deleteJournalEntry,
  findCorrelatedEntries,
  findDuplicateEntries,
  updateJournalEntry,
  updateJournalLine,
} from "../../db/queries/journal.js";
import {
  findRecurrenceCandidates,
  linkEntryToRecurrence,
  recordRecurrence,
  type RecurrenceFrequency,
} from "../../db/queries/recurrences.js";
import { formatCurrencyAmount } from "../../currency.js";
import { sanitizeForPrompt } from "../sanitize.js";
import type { AgentExecutionContext, ToolDefinition, ToolModule } from "./types.js";

function formatTHB(amount: number): string {
  return formatCurrencyAmount(amount, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const DEFS: ToolDefinition[] = [
  {
    name: "update_journal_entry",
    description: "Header-only update: date, description, or source_page. To change amounts, delete the entry and record a new one.",
    input_schema: {
      type: "object",
      properties: {
        entry_id: { type: "string" },
        date: { type: "string" },
        description: { type: "string" },
        source_page: { type: "number" },
      },
      required: ["entry_id"],
    },
  },
  {
    name: "update_journal_line",
    description: "Safe single-line edit: re-categorize (account_id) or update memo. Refuses changes to debit/credit/currency — delete and re-record the entry for those.",
    input_schema: {
      type: "object",
      properties: {
        line_id: { type: "string" },
        account_id: { type: "string" },
        memo: { type: "string" },
      },
      required: ["line_id"],
    },
  },
  {
    name: "delete_journal_entry",
    description: "Delete an entry and (via cascade) all its lines. The primitive for removing duplicates.",
    input_schema: {
      type: "object",
      properties: { entry_id: { type: "string" } },
      required: ["entry_id"],
    },
  },
  {
    name: "rename_account",
    description: "Rename an account. Leaves lines and metadata untouched.",
    input_schema: {
      type: "object",
      properties: { account_id: { type: "string" }, name: { type: "string" } },
      required: ["account_id", "name"],
    },
  },
  {
    name: "merge_accounts",
    description: "Move every journal line on `from_id` over to `to_id`, then delete the source account. Use to collapse duplicate accounts.",
    input_schema: {
      type: "object",
      properties: { from_id: { type: "string" }, to_id: { type: "string" } },
      required: ["from_id", "to_id"],
    },
  },
  {
    name: "delete_account",
    description: "Delete an account that has no journal lines. Refuses if any line still references it — merge first.",
    input_schema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      required: ["account_id"],
    },
  },
  {
    name: "find_duplicate_entries",
    description: "Heuristic: groups journal entries by total amount and a configurable date tolerance. Returns groups with two or more candidate dupes.",
    input_schema: {
      type: "object",
      properties: {
        tolerance_days: { type: "number", default: 2 },
        account_id: { type: "string" },
        min_amount: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "find_similar_accounts",
    description: "Pairwise Levenshtein similarity on account names. Returns pairs above the threshold, sorted highest first.",
    input_schema: {
      type: "object",
      properties: { threshold: { type: "number", default: 0.85 } },
      required: [],
    },
  },
  {
    name: "find_unused_accounts",
    description: "Accounts with zero linked journal lines.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "find_correlated_entries",
    description: "Surface pairs of entries that look like the same money movement recorded against different accounts (a transfer recorded once on each statement). Pairs are filtered: same amount + currency, within `tolerance_days` of each other, and the two entries share no account_ids (overlap → duplicate, not correlation).",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO date inclusive lower bound (YYYY-MM-DD)." },
        to: { type: "string", description: "ISO date inclusive upper bound (YYYY-MM-DD)." },
        tolerance_days: { type: "number", default: 3, description: "Max day gap between paired entries." },
        min_amount: { type: "number", default: 0 },
      },
      required: [],
    },
  },
  {
    name: "find_recurrences",
    description: "Detect candidate recurring transactions by grouping unlinked entries on the same account + amount + side (debit/credit), then classifying cadence (weekly/biweekly/monthly/annually/irregular) from the median gap between consecutive dates. Skips entries already linked to a recurrence.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "Limit to one account; omit for all." },
        min_occurrences: { type: "number", default: 3, description: "Minimum sightings to qualify." },
      },
      required: [],
    },
  },
  {
    name: "record_recurrence",
    description: "Create a recurrences row and link every supplied journal entry to it. Computes first_seen_date, last_seen_date, and next_expected_date from the member entries. Use this after the user confirms a recurrence candidate.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "The account this recurs on." },
        description: { type: "string", description: "Human label, e.g. 'Spotify subscription', 'Salary', 'Rent'." },
        frequency: { type: "string", enum: ["weekly", "biweekly", "monthly", "annually"] },
        amount_typical: { type: "number", description: "Representative amount (typically the matching amount of the member entries)." },
        currency: { type: "string", default: "THB" },
        entry_ids: { type: "array", items: { type: "string" }, description: "Journal entry ids to link to this recurrence." },
        notes: { type: "string", description: "Optional context the chat agent can read later." },
      },
      required: ["account_id", "description", "frequency", "entry_ids"],
    },
  },
  {
    name: "link_entry_to_recurrence",
    description: "Attach a single newly-seen entry to an existing recurrence. Recomputes last_seen_date and next_expected_date on the recurrence.",
    input_schema: {
      type: "object",
      properties: {
        entry_id: { type: "string" },
        recurrence_id: { type: "string" },
      },
      required: ["entry_id", "recurrence_id"],
    },
  },
  {
    name: "mark_review_done",
    description: "Call when the review pass is complete. The summary is shown to the user.",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    },
  },
];

const LABELS: Record<string, string> = {
  update_journal_entry: "Updating journal entry",
  update_journal_line: "Updating journal line",
  delete_journal_entry: "Deleting journal entry",
  rename_account: "Renaming account",
  merge_accounts: "Merging accounts",
  delete_account: "Deleting account",
  find_duplicate_entries: "Finding duplicate entries",
  find_similar_accounts: "Finding similar accounts",
  find_unused_accounts: "Finding unused accounts",
  find_correlated_entries: "Finding correlated entries",
  find_recurrences: "Finding recurrences",
  record_recurrence: "Recording recurrence",
  link_entry_to_recurrence: "Linking entry to recurrence",
  mark_review_done: "Finalizing review",
};

async function execute(
  db: Database.Database,
  name: string,
  input: any,
  ctx: AgentExecutionContext | undefined,
): Promise<string | undefined> {
  switch (name) {
    case "update_journal_entry": {
      if (ctx?.dryRun) return `Would update entry ${input.entry_id}: ${JSON.stringify(input)}`;
      const changed = updateJournalEntry(db, input.entry_id, {
        date: input.date,
        description: input.description,
        source_page: input.source_page,
      });
      return changed === 0
        ? `Entry ${input.entry_id} not found or no fields to update.`
        : `Updated entry ${input.entry_id}.`;
    }
    case "update_journal_line": {
      if (ctx?.dryRun) return `Would update line ${input.line_id}: ${JSON.stringify(input)}`;
      const changed = updateJournalLine(db, input.line_id, {
        account_id: input.account_id,
        memo: input.memo,
      });
      return changed === 0
        ? `Line ${input.line_id} not found or no fields to update.`
        : `Updated line ${input.line_id}.`;
    }
    case "delete_journal_entry": {
      if (ctx?.dryRun) return `Would delete entry ${input.entry_id} (and its lines).`;
      const changed = deleteJournalEntry(db, input.entry_id);
      return changed === 0
        ? `Entry ${input.entry_id} not found.`
        : `Deleted entry ${input.entry_id} and its lines.`;
    }
    case "rename_account": {
      if (ctx?.dryRun) return `Would rename ${input.account_id} → "${input.name}".`;
      const changed = renameAccount(db, input.account_id, input.name);
      return changed === 0
        ? `Account ${input.account_id} not found.`
        : `Renamed ${input.account_id} → "${sanitizeForPrompt(input.name)}".`;
    }
    case "merge_accounts": {
      if (ctx?.dryRun) return `Would merge ${input.from_id} → ${input.to_id}.`;
      try {
        const moved = mergeAccounts(db, input.from_id, input.to_id);
        return `Merged ${input.from_id} → ${input.to_id}; moved ${moved} line(s).`;
      } catch (err: any) {
        return `Could not merge: ${err.message}`;
      }
    }
    case "delete_account": {
      if (ctx?.dryRun) return `Would delete account ${input.account_id}.`;
      try {
        deleteAccount(db, input.account_id);
        return `Deleted account ${input.account_id}.`;
      } catch (err: any) {
        return `Could not delete: ${err.message}`;
      }
    }
    case "find_duplicate_entries": {
      const groups = findDuplicateEntries(db, {
        toleranceDays: input.tolerance_days,
        accountId: input.account_id,
        minAmount: input.min_amount,
      });
      if (groups.length === 0) return "No candidate duplicate groups found.";
      return groups
        .map((g, i) => {
          const header = `Group ${i + 1} — ${formatTHB(g[0].amount)}`;
          const lines = g.map((e, j) => {
            const accounts = e.account_names.length > 0
              ? e.account_names.map(n => sanitizeForPrompt(n)).join(", ")
              : "(no lines)";
            return `  ${j + 1}. ${e.date} "${sanitizeForPrompt(e.description)}" — ${accounts}    [${e.id}]`;
          });
          return `${header}\n${lines.join("\n")}`;
        })
        .join("\n\n");
    }
    case "find_similar_accounts": {
      const pairs = findSimilarAccounts(db, input.threshold);
      if (pairs.length === 0) return "No similar account pairs above threshold.";
      return pairs
        .map(p => `${p.similarity}: ${p.a.id} (${sanitizeForPrompt(p.a.name)}) <-> ${p.b.id} (${sanitizeForPrompt(p.b.name)})`)
        .join("\n");
    }
    case "find_unused_accounts": {
      const rows = findUnusedAccounts(db);
      if (rows.length === 0) return "No unused accounts.";
      return rows.map(a => `${a.id} | ${sanitizeForPrompt(a.name)} | ${a.type}`).join("\n");
    }
    case "find_correlated_entries": {
      const pairs = findCorrelatedEntries(db, {
        from: input.from,
        to: input.to,
        toleranceDays: input.tolerance_days,
        minAmount: input.min_amount,
      });
      if (pairs.length === 0) return "No correlated entry pairs found.";
      return pairs
        .map((p, i) => {
          const accountsA = p.a.account_names.length > 0
            ? p.a.account_names.map(n => sanitizeForPrompt(n)).join(", ")
            : "(no lines)";
          const accountsB = p.b.account_names.length > 0
            ? p.b.account_names.map(n => sanitizeForPrompt(n)).join(", ")
            : "(no lines)";
          return [
            `Pair ${i + 1} — ${formatTHB(p.amount)} ${p.currency} (gap ${p.day_gap} day${p.day_gap === 1 ? "" : "s"})`,
            `  A: ${p.a.date} "${sanitizeForPrompt(p.a.description)}" — ${accountsA}    [${p.a.id}]`,
            `  B: ${p.b.date} "${sanitizeForPrompt(p.b.description)}" — ${accountsB}    [${p.b.id}]`,
          ].join("\n");
        })
        .join("\n\n");
    }
    case "find_recurrences": {
      const candidates = findRecurrenceCandidates(db, {
        accountId: input.account_id,
        minOccurrences: input.min_occurrences,
      });
      if (candidates.length === 0) return "No recurrence candidates found.";
      return candidates
        .map((c, i) => {
          const dates = c.entries.map(e => e.date).join(", ");
          const ids = c.entries.map(e => e.id).join(", ");
          return [
            `Candidate ${i + 1} — ${formatTHB(c.amount)} ${c.currency} on ${sanitizeForPrompt(c.account_name)} (${c.side})`,
            `  Sightings (${c.entries.length}): ${dates}`,
            `  Median gap: ${c.median_days_between} day(s) → implied ${c.implied_frequency}`,
            `  Entry ids: ${ids}`,
          ].join("\n");
        })
        .join("\n\n");
    }
    case "record_recurrence": {
      if (ctx?.dryRun) return `Would record ${input.frequency} recurrence "${input.description}" linking ${(input.entry_ids || []).length} entries on ${input.account_id}.`;
      try {
        const id = recordRecurrence(db, {
          account_id: input.account_id,
          description: input.description,
          frequency: input.frequency as RecurrenceFrequency,
          amount_typical: input.amount_typical ?? null,
          currency: input.currency,
          entry_ids: input.entry_ids || [],
          notes: input.notes ?? null,
        });
        return `Recorded recurrence ${id} ("${sanitizeForPrompt(input.description)}", ${input.frequency}); linked ${(input.entry_ids || []).length} entry(ies).`;
      } catch (err: any) {
        return `Could not record recurrence: ${err.message}`;
      }
    }
    case "link_entry_to_recurrence": {
      if (ctx?.dryRun) return `Would link entry ${input.entry_id} → recurrence ${input.recurrence_id}.`;
      try {
        linkEntryToRecurrence(db, input.entry_id, input.recurrence_id);
        return `Linked entry ${input.entry_id} → recurrence ${input.recurrence_id}.`;
      } catch (err: any) {
        return `Could not link: ${err.message}`;
      }
    }
    case "mark_review_done": {
      ctx?.onComplete?.(input.summary || "");
      return `Review complete. Summary: ${sanitizeForPrompt(input.summary || "")}`;
    }
    default:
      return undefined;
  }
}

export const reviewTools: ToolModule = { DEFS, LABELS, execute };
