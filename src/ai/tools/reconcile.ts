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
  findDuplicateEntries,
  updateJournalEntry,
  updateJournalLine,
} from "../../db/queries/journal.js";
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
    name: "mark_reconcile_done",
    description: "Call when reconciliation is complete. The summary is shown to the user.",
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
  mark_reconcile_done: "Finalizing reconcile",
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
    case "mark_reconcile_done": {
      ctx?.onComplete?.(input.summary || "");
      return `Reconcile complete. Summary: ${sanitizeForPrompt(input.summary || "")}`;
    }
    default:
      return undefined;
  }
}

export const reconcileTools: ToolModule = { DEFS, LABELS, execute };
