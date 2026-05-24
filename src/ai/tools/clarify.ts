import type Database from "libsql";
import {
  deleteTransaction,
  updateTransaction,
  updatePosting,
} from "../../db/queries/transactions.js";
import { mergeAccounts } from "../../db/queries/account-balance.js";
import {
  linkTransactionToRecurrence,
  recordRecurrence,
  type RecurrenceFrequency,
} from "../../db/queries/recurrences.js";
import { deleteScannedFile, listScannedFiles } from "../../db/queries/files.js";
import { sanitizeForPrompt } from "../sanitize.js";
import type {
  AgentExecutionContext,
  ToolDefinition,
  ToolModule,
} from "./types.js";

const DEFS: ToolDefinition[] = [
  {
    name: "update_transaction",
    description:
      "Header-only update: date, description, or source_page. To change amounts, delete the transaction and record a new one.",
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
    description:
      "Safe single-posting edit: re-categorize (account_id) or update memo. Refuses changes to debit/credit/currency — delete and re-record the transaction for those.",
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
    description:
      "Delete a transaction and (via cascade) all its postings. The primitive for removing duplicates.",
    input_schema: {
      type: "object",
      properties: { transaction_id: { type: "string" } },
      required: ["transaction_id"],
    },
  },
  {
    name: "record_recurrence",
    description:
      "Create a recurrences row and link every supplied transaction to it. Computes first_seen_date, last_seen_date, and next_expected_date from the member transactions. Use this after the user confirms a recurrence_candidate question.",
    input_schema: {
      type: "object",
      properties: {
        account_id: {
          type: "string",
          description: "The account this recurs on.",
        },
        description: {
          type: "string",
          description:
            "Human label, e.g. 'Spotify subscription', 'Salary', 'Rent'.",
        },
        frequency: {
          type: "string",
          enum: ["weekly", "biweekly", "monthly", "annually"],
        },
        amount_typical: {
          type: "number",
          description:
            "Representative amount (typically the matching amount of the member transactions).",
        },
        currency: { type: "string", default: "THB" },
        transaction_ids: {
          type: "array",
          items: { type: "string" },
          description: "Transaction ids to link to this recurrence.",
        },
        notes: {
          type: "string",
          description: "Optional context the chat agent can read later.",
        },
      },
      required: ["account_id", "description", "frequency", "transaction_ids"],
    },
  },
  {
    name: "link_transaction_to_recurrence",
    description:
      "Attach a single newly-seen transaction to an existing recurrence. Recomputes last_seen_date and next_expected_date on the recurrence.",
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
    name: "merge_accounts",
    description:
      "Move every posting on `from_id` over to `to_id`, then delete the source account. Use to apply a similar_accounts question's 'Merge A into B' resolution. Refuses if the source still has child accounts.",
    input_schema: {
      type: "object",
      properties: { from_id: { type: "string" }, to_id: { type: "string" } },
      required: ["from_id", "to_id"],
    },
  },
  {
    name: "list_scanned_files",
    description:
      "List every scanned_files row with id, path, status, provider, model, and scanned_at. Use to resolve a file the user mentions by name (e.g. 'drop march-statement.pdf') into a file_id before calling delete_scanned_file. Returns at most 200 rows, newest first.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "delete_scanned_file",
    description:
      "Delete a scanned_files row by id. Cascades to remove every transaction and question tied to that file (via ON DELETE CASCADE). Use ONLY when the user explicitly wants to drop a file's data so they can re-scan it with a different model — e.g. 'this scan came out wrong, let me redo it'. Never use to resolve a single question; that's `close_question`. Always confirm with the user before calling: cascading deletes are irreversible.",
    input_schema: {
      type: "object",
      properties: { file_id: { type: "string" } },
      required: ["file_id"],
    },
  },
];

const LABELS: Record<string, string> = {
  update_transaction: "Updating transaction",
  update_posting: "Updating posting",
  delete_transaction: "Deleting transaction",
  record_recurrence: "Recording recurrence",
  link_transaction_to_recurrence: "Linking transaction to recurrence",
  merge_accounts: "Merging accounts",
  list_scanned_files: "Listing scanned files",
  delete_scanned_file: "Deleting scanned file",
};

async function execute(
  db: Database.Database,
  name: string,
  input: any,
  _ctx: AgentExecutionContext | undefined,
): Promise<string | undefined> {
  switch (name) {
    case "update_transaction": {
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
      const changed = updatePosting(db, input.posting_id, {
        account_id: input.account_id,
        memo: input.memo,
      });
      return changed === 0
        ? `Posting ${input.posting_id} not found or no fields to update.`
        : `Updated posting ${input.posting_id}.`;
    }
    case "delete_transaction": {
      const changed = deleteTransaction(db, input.transaction_id);
      return changed === 0
        ? `Transaction ${input.transaction_id} not found.`
        : `Deleted transaction ${input.transaction_id} and its postings.`;
    }
    case "record_recurrence": {
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
      try {
        linkTransactionToRecurrence(
          db,
          input.transaction_id,
          input.recurrence_id,
        );
        return `Linked transaction ${input.transaction_id} → recurrence ${input.recurrence_id}.`;
      } catch (err: any) {
        return `Could not link: ${err.message}`;
      }
    }
    case "merge_accounts": {
      const moved = mergeAccounts(db, input.from_id, input.to_id);
      return `Merged ${input.from_id} → ${input.to_id}; moved ${moved} posting(s).`;
    }
    case "list_scanned_files": {
      const files = listScannedFiles(db).slice(0, 200);
      if (files.length === 0) return "No scanned files on record.";
      return files
        .map(f => {
          const stamp = f.provider && f.model ? ` [${f.provider}/${f.model}]` : "";
          const when = f.scanned_at ? ` · ${f.scanned_at}` : "";
          return `${f.id} | ${sanitizeForPrompt(f.path)} | ${f.status}${stamp}${when}`;
        })
        .join("\n");
    }
    case "delete_scanned_file": {
      const result = deleteScannedFile(db, input.file_id);
      if (!result.removed) return `Scanned file ${input.file_id} not found.`;
      return `Deleted scanned file ${result.removed.path} (${input.file_id}); cascade removed ${result.removedTransactions} transaction(s) and ${result.removedQuestions} question(s).`;
    }
    default:
      return undefined;
  }
}

export const clarifyTools: ToolModule = { DEFS, LABELS, execute };
