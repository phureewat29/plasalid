import type Database from "libsql";
import {
  bulkUpdatePostings,
  type BulkUpdatePostingsFilter,
  type BulkUpdatePostingsSet,
} from "../../db/queries/transactions.js";
import type {
  AgentExecutionContext,
  ToolDefinition,
  ToolModule,
} from "./types.js";

const DEFS: ToolDefinition[] = [
  {
    name: "bulk_update_postings",
    description:
      "Recategorize (and/or re-memo) every posting matching the filter in a single call. " +
      "Use this when the user confirms a categorization rule for past data " +
      "(e.g. \"every salary from บริษัท คริปโตมายด์ should be income:salary\"). " +
      "Pair this with save_memory so the rule also persists for future sessions. " +
      "For amount/currency corrections, delete the transaction and re-record it instead.",
    input_schema: {
      type: "object",
      properties: {
        filter: {
          type: "object",
          description: "At least one field is required.",
          properties: {
            account_id: {
              type: "string",
              description: "Current account (e.g. income:uncategorized).",
            },
            description_contains: {
              type: "string",
              description:
                "Case-insensitive substring match against the transaction description. " +
                "Use multiple calls for descriptor variants (no regex).",
            },
            currency: { type: "string" },
            from: { type: "string", description: "ISO date (inclusive)." },
            to: { type: "string", description: "ISO date (inclusive)." },
            merchant_id: { type: "string" },
          },
        },
        set: {
          type: "object",
          description: "At least one field is required.",
          properties: {
            account_id: {
              type: "string",
              description: "New account_id to assign to every matching posting.",
            },
            memo: {
              type: "string",
              description: "New memo to apply to every matching posting.",
            },
          },
        },
      },
      required: ["filter", "set"],
    },
  },
];

const LABELS: Record<string, string> = {
  bulk_update_postings: "Backfilling postings",
};

async function execute(
  db: Database.Database,
  name: string,
  input: any,
  _ctx: AgentExecutionContext | undefined,
): Promise<string | undefined> {
  if (name !== "bulk_update_postings") return undefined;
  try {
    const filter = (input?.filter ?? {}) as BulkUpdatePostingsFilter;
    const set = (input?.set ?? {}) as BulkUpdatePostingsSet;
    const result = bulkUpdatePostings(db, filter, set);
    if (result.affected === 0) {
      return "No postings matched the filter; nothing changed.";
    }
    const targetSummary = describeSet(set);
    const sample = result.sample_posting_ids.join(", ");
    return (
      `Updated ${result.affected} posting(s) → ${targetSummary}. ` +
      `Sample ids: ${sample}.`
    );
  } catch (err: any) {
    return `Could not bulk update postings: ${err?.message ?? String(err)}`;
  }
}

function describeSet(set: BulkUpdatePostingsSet): string {
  const parts: string[] = [];
  if (set.account_id !== undefined) parts.push(`account_id=${set.account_id}`);
  if (set.memo !== undefined) parts.push(`memo=${JSON.stringify(set.memo)}`);
  return parts.join(", ") || "(no changes)";
}

export const mutateTools: ToolModule = { DEFS, LABELS, execute };
