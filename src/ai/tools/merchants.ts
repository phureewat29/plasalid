import type Database from "libsql";
import {
  upsertMerchant,
  findMerchantByAlias,
  findMerchantById,
  setMerchantDefaultAccount,
} from "../../db/queries/merchants.js";
import { appendAction } from "../../db/queries/action_log.js";
import { sanitizeForPrompt } from "../sanitize.js";
import type { AgentExecutionContext, ToolDefinition, ToolModule } from "./types.js";

/**
 * Merchant tools
 *
 * Used by record-mode for utterances about merchants ("set Starbucks default
 * to Dining") and by the scanner pipeline for pre-resolution lookups. The
 * scan path normally resolves merchants inline via `record_transaction`'s
 * embedded `merchant` block; these standalone tools exist for the cases where
 * the LLM needs to query or update merchants without posting a transaction.
 */

const DEFS: ToolDefinition[] = [
  {
    name: "find_or_create_merchant",
    description:
      "Upsert a merchant by canonical_name. Optionally register a raw-descriptor alias and a learned default expense account. Returns the merchant row. Use this in record mode for utterances like 'add Spotify as a subscription merchant' or 'mark Starbucks as Dining'.",
    input_schema: {
      type: "object",
      properties: {
        canonical_name: { type: "string", description: "Title-cased merchant name, e.g. 'Starbucks', 'Amazon'." },
        alias: { type: "string", description: "Optional raw descriptor (as seen on a statement). Plasalid normalizes and dedups it." },
        default_account_id: { type: "string", description: "Optional learned cache: the merchant's default expense account." },
      },
      required: ["canonical_name"],
    },
  },
  {
    name: "find_merchant_by_descriptor",
    description:
      "Look up an existing merchant by its raw descriptor (alias match after normalization). Returns null if no alias matches.",
    input_schema: {
      type: "object",
      properties: {
        descriptor: { type: "string", description: "The raw statement line or merchant string to look up." },
      },
      required: ["descriptor"],
    },
  },
  {
    name: "set_merchant_default_account",
    description:
      "Update a merchant's learned default expense account. Use after the user (or you) recategorizes a posting so future statements skip the LLM categorizer.",
    input_schema: {
      type: "object",
      properties: {
        merchant_id: { type: "string" },
        account_id: { type: "string" },
      },
      required: ["merchant_id", "account_id"],
    },
  },
];

const LABELS: Record<string, string> = {
  find_or_create_merchant: "Resolving merchant",
  find_merchant_by_descriptor: "Looking up merchant",
  set_merchant_default_account: "Updating merchant default",
};

async function execute(
  db: Database.Database,
  name: string,
  input: any,
  ctx: AgentExecutionContext | undefined,
): Promise<string | undefined> {
  switch (name) {
    case "find_or_create_merchant": {
      if (ctx?.dryRun) return `Would upsert merchant "${input.canonical_name}".`;
      const existing = db
        .prepare(`SELECT id FROM merchants WHERE canonical_name = ?`)
        .get(input.canonical_name) as { id: string } | undefined;
      const merchant = upsertMerchant(db, {
        canonical_name: input.canonical_name,
        alias: input.alias,
        default_account_id: input.default_account_id,
      });
      if (ctx?.correlationId && !existing) {
        appendAction(db, {
          correlation_id: ctx.correlationId,
          command: ctx.command ?? "record",
          user_input: ctx.userInput ?? null,
          action_type: "create_merchant",
          target_id: merchant.id,
          payload: { canonical_name: merchant.canonical_name, default_account_id: merchant.default_account_id },
        });
      }
      const defaultStr = merchant.default_account_id ? ` (default → ${merchant.default_account_id})` : "";
      return `Merchant ${merchant.id}: ${sanitizeForPrompt(merchant.canonical_name)}${defaultStr}.`;
    }

    case "find_merchant_by_descriptor": {
      const hit = findMerchantByAlias(db, String(input.descriptor ?? ""));
      if (!hit) return `No merchant matched descriptor "${sanitizeForPrompt(String(input.descriptor ?? ""))}".`;
      const defaultStr = hit.default_account_id ? ` (default → ${hit.default_account_id})` : "";
      return `Merchant ${hit.merchant.id}: ${sanitizeForPrompt(hit.merchant.canonical_name)}${defaultStr}.`;
    }

    case "set_merchant_default_account": {
      if (ctx?.dryRun) return `Would set ${input.merchant_id}'s default to ${input.account_id}.`;
      const m = findMerchantById(db, input.merchant_id);
      if (!m) return `Merchant ${input.merchant_id} not found.`;
      try {
        const result = setMerchantDefaultAccount(db, input.merchant_id, input.account_id);
        if (ctx?.correlationId) {
          appendAction(db, {
            correlation_id: ctx.correlationId,
            command: ctx.command ?? "record",
            user_input: ctx.userInput ?? null,
            action_type: "update_merchant_default",
            target_id: input.merchant_id,
            payload: { before: result.before, after: result.after },
          });
        }
        return `Merchant ${input.merchant_id}: default ${result.before ?? "(none)"} → ${result.after}.`;
      } catch (err: any) {
        return `Could not set merchant default: ${err.message}`;
      }
    }

    default:
      return undefined;
  }
}

export const merchantTools: ToolModule = { DEFS, LABELS, execute };
