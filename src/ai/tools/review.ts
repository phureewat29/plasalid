import type Database from "libsql";
import {
  deleteAccount,
  findSimilarAccounts,
  findUnusedAccounts,
  mergeAccounts,
  renameAccount,
} from "../../db/queries/account_balance.js";
import {
  deleteTransaction,
  findCorrelatedTransactions,
  findDuplicateTransactions,
  updateTransaction,
  updatePosting,
} from "../../db/queries/transactions.js";
import {
  findRecurrenceCandidates,
  linkTransactionToRecurrence,
  recordRecurrence,
  type RecurrenceFrequency,
} from "../../db/queries/recurrences.js";
import { formatAmount } from "../../currency.js";
import { sanitizeForPrompt } from "../sanitize.js";
import type { AgentExecutionContext, ToolDefinition, ToolModule } from "./types.js";

const DEFS: ToolDefinition[] = [
  {
    name: "update_transaction",
    description: "Header-only update: date, description, or source_page. To change amounts, delete the transaction and record a new one.",
    input_schema: {
      type: "object",
      properties: {
        transaction_id: { type: "string" },
        date: { type: "string" },
        description: { type: "string" },
        source_page: { type: "number" },
      },
      required: ["transaction_id"],
    },
  },
  {
    name: "update_posting",
    description: "Safe single-posting edit: re-categorize (account_id) or update memo. Refuses changes to debit/credit/currency — delete and re-record the transaction for those.",
    input_schema: {
      type: "object",
      properties: {
        posting_id: { type: "string" },
        account_id: { type: "string" },
        memo: { type: "string" },
      },
      required: ["posting_id"],
    },
  },
  {
    name: "delete_transaction",
    description: "Delete a transaction and (via cascade) all its postings. The primitive for removing duplicates.",
    input_schema: {
      type: "object",
      properties: { transaction_id: { type: "string" } },
      required: ["transaction_id"],
    },
  },
  {
    name: "rename_account",
    description: "Rename an account. Leaves postings and metadata untouched.",
    input_schema: {
      type: "object",
      properties: { account_id: { type: "string" }, name: { type: "string" } },
      required: ["account_id", "name"],
    },
  },
  {
    name: "merge_accounts",
    description: "Move every posting on `from_id` over to `to_id`, then delete the source account. Use to collapse duplicate accounts. Refuses if the source still has child accounts.",
    input_schema: {
      type: "object",
      properties: { from_id: { type: "string" }, to_id: { type: "string" } },
      required: ["from_id", "to_id"],
    },
  },
  {
    name: "delete_account",
    description: "Delete an account that has no postings and no children. Refuses if any posting or child still references it — merge first.",
    input_schema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      required: ["account_id"],
    },
  },
  {
    name: "find_duplicate_transactions",
    description: "Heuristic: groups transactions by total amount and a configurable date tolerance. Returns groups with two or more candidate dupes.",
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
    description: "Accounts with zero postings and no children (excludes the five top-level type roots).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "find_correlated_transactions",
    description: "Surface pairs of transactions that look like the same money movement recorded against different accounts (a transfer recorded once on each statement). Pairs are filtered: same amount + currency, within `tolerance_days` of each other, and the two transactions share no account_ids (overlap → duplicate, not correlation).",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO date inclusive lower bound (YYYY-MM-DD)." },
        to: { type: "string", description: "ISO date inclusive upper bound (YYYY-MM-DD)." },
        tolerance_days: { type: "number", default: 3, description: "Max day gap between paired transactions." },
        min_amount: { type: "number", default: 0 },
      },
      required: [],
    },
  },
  {
    name: "find_recurrences",
    description: "Detect candidate recurring transactions by grouping unlinked transactions on the same account + amount + side (debit/credit), then classifying cadence (weekly/biweekly/monthly/annually/irregular) from the median gap between consecutive dates. Skips transactions already linked to a recurrence.",
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
    description: "Create a recurrences row and link every supplied transaction to it. Computes first_seen_date, last_seen_date, and next_expected_date from the member transactions. Use this after the user confirms a recurrence candidate.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "The account this recurs on." },
        description: { type: "string", description: "Human label, e.g. 'Spotify subscription', 'Salary', 'Rent'." },
        frequency: { type: "string", enum: ["weekly", "biweekly", "monthly", "annually"] },
        amount_typical: { type: "number", description: "Representative amount (typically the matching amount of the member transactions)." },
        currency: { type: "string", default: "THB" },
        transaction_ids: { type: "array", items: { type: "string" }, description: "Transaction ids to link to this recurrence." },
        notes: { type: "string", description: "Optional context the chat agent can read later." },
      },
      required: ["account_id", "description", "frequency", "transaction_ids"],
    },
  },
  {
    name: "link_transaction_to_recurrence",
    description: "Attach a single newly-seen transaction to an existing recurrence. Recomputes last_seen_date and next_expected_date on the recurrence.",
    input_schema: {
      type: "object",
      properties: {
        transaction_id: { type: "string" },
        recurrence_id: { type: "string" },
      },
      required: ["transaction_id", "recurrence_id"],
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
  update_transaction: "Updating transaction",
  update_posting: "Updating posting",
  delete_transaction: "Deleting transaction",
  rename_account: "Renaming account",
  merge_accounts: "Merging accounts",
  delete_account: "Deleting account",
  find_duplicate_transactions: "Finding duplicate transactions",
  find_similar_accounts: "Finding similar accounts",
  find_unused_accounts: "Finding unused accounts",
  find_correlated_transactions: "Finding correlated transactions",
  find_recurrences: "Finding recurrences",
  record_recurrence: "Recording recurrence",
  link_transaction_to_recurrence: "Linking transaction to recurrence",
  mark_review_done: "Finalizing review",
};

async function execute(
  db: Database.Database,
  name: string,
  input: any,
  ctx: AgentExecutionContext | undefined,
): Promise<string | undefined> {
  switch (name) {
    case "update_transaction": {
      if (ctx?.dryRun) return `Would update transaction ${input.transaction_id}: ${JSON.stringify(input)}`;
      const changed = updateTransaction(db, input.transaction_id, {
        date: input.date,
        description: input.description,
        source_page: input.source_page,
      });
      return changed === 0
        ? `Transaction ${input.transaction_id} not found or no fields to update.`
        : `Updated transaction ${input.transaction_id}.`;
    }
    case "update_posting": {
      if (ctx?.dryRun) return `Would update posting ${input.posting_id}: ${JSON.stringify(input)}`;
      const changed = updatePosting(db, input.posting_id, {
        account_id: input.account_id,
        memo: input.memo,
      });
      return changed === 0
        ? `Posting ${input.posting_id} not found or no fields to update.`
        : `Updated posting ${input.posting_id}.`;
    }
    case "delete_transaction": {
      if (ctx?.dryRun) return `Would delete transaction ${input.transaction_id} (and its postings).`;
      const changed = deleteTransaction(db, input.transaction_id);
      return changed === 0
        ? `Transaction ${input.transaction_id} not found.`
        : `Deleted transaction ${input.transaction_id} and its postings.`;
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
        return `Merged ${input.from_id} → ${input.to_id}; moved ${moved} posting(s).`;
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
    case "find_duplicate_transactions": {
      const groups = findDuplicateTransactions(db, {
        toleranceDays: input.tolerance_days,
        accountId: input.account_id,
        minAmount: input.min_amount,
      });
      if (groups.length === 0) return "No candidate duplicate groups found.";
      return groups
        .map((g, i) => {
          const header = `Group ${i + 1} — ${formatAmount(g[0].amount)}`;
          const lines = g.map((e, j) => {
            const accounts = e.account_names.length > 0
              ? e.account_names.map(n => sanitizeForPrompt(n)).join(", ")
              : "(no postings)";
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
    case "find_correlated_transactions": {
      const pairs = findCorrelatedTransactions(db, {
        from: input.from,
        to: input.to,
        toleranceDays: input.tolerance_days,
        minAmount: input.min_amount,
      });
      if (pairs.length === 0) return "No correlated transaction pairs found.";
      return pairs
        .map((p, i) => {
          const accountsA = p.a.account_names.length > 0
            ? p.a.account_names.map(n => sanitizeForPrompt(n)).join(", ")
            : "(no postings)";
          const accountsB = p.b.account_names.length > 0
            ? p.b.account_names.map(n => sanitizeForPrompt(n)).join(", ")
            : "(no postings)";
          return [
            `Pair ${i + 1} — ${formatAmount(p.amount)} ${p.currency} (gap ${p.day_gap} day${p.day_gap === 1 ? "" : "s"})`,
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
          const dates = c.transactions.map(e => e.date).join(", ");
          const ids = c.transactions.map(e => e.id).join(", ");
          return [
            `Candidate ${i + 1} — ${formatAmount(c.amount)} ${c.currency} on ${sanitizeForPrompt(c.account_name)} (${c.side})`,
            `  Sightings (${c.transactions.length}): ${dates}`,
            `  Median gap: ${c.median_days_between} day(s) → implied ${c.implied_frequency}`,
            `  Transaction ids: ${ids}`,
          ].join("\n");
        })
        .join("\n\n");
    }
    case "record_recurrence": {
      if (ctx?.dryRun) return `Would record ${input.frequency} recurrence "${input.description}" linking ${(input.transaction_ids || []).length} transactions on ${input.account_id}.`;
      try {
        const id = recordRecurrence(db, {
          account_id: input.account_id,
          description: input.description,
          frequency: input.frequency as RecurrenceFrequency,
          amount_typical: input.amount_typical ?? null,
          currency: input.currency,
          transaction_ids: input.transaction_ids || [],
          notes: input.notes ?? null,
        });
        return `Recorded recurrence ${id} ("${sanitizeForPrompt(input.description)}", ${input.frequency}); linked ${(input.transaction_ids || []).length} transaction(s).`;
      } catch (err: any) {
        return `Could not record recurrence: ${err.message}`;
      }
    }
    case "link_transaction_to_recurrence": {
      if (ctx?.dryRun) return `Would link transaction ${input.transaction_id} → recurrence ${input.recurrence_id}.`;
      try {
        linkTransactionToRecurrence(db, input.transaction_id, input.recurrence_id);
        return `Linked transaction ${input.transaction_id} → recurrence ${input.recurrence_id}.`;
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
