import type Database from "libsql";
import { saveMemory, getMemories } from "../memory.js";
import { getAccountBalances } from "../../db/queries/account_balance.js";
import { formatCurrencyAmount } from "../../currency.js";
import { sanitizeForPrompt, sanitizeForPromptCell } from "../sanitize.js";
import { ACCOUNT_TYPE_DESCRIPTIONS } from "../../accounts/taxonomy.js";
import type { AgentExecutionContext, ToolDefinition, ToolModule } from "./types.js";

const ACCOUNT_TYPES = Object.keys(ACCOUNT_TYPE_DESCRIPTIONS);

function formatTHB(amount: number): string {
  return formatCurrencyAmount(amount, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const DEFS: ToolDefinition[] = [
  {
    name: "list_accounts",
    description: "List accounts in the chart of accounts, optionally filtered by type.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ACCOUNT_TYPES, description: "Filter by account type." },
      },
      required: [],
    },
  },
  {
    name: "save_memory",
    description: "Persist a fact or bank-specific scanning hint to long-term memory.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "What to remember." },
        category: { type: "string", description: "Category: general, scanning_hint, preference, life_event.", default: "general" },
      },
      required: ["content"],
    },
  },
  {
    name: "get_memories",
    description: "Retrieve all saved long-term memories.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

const LABELS: Record<string, string> = {
  list_accounts: "Listing accounts",
  save_memory: "Saving memory",
  get_memories: "Recalling memories",
};

async function execute(
  db: Database.Database,
  name: string,
  input: any,
  _ctx: AgentExecutionContext | undefined,
): Promise<string | undefined> {
  switch (name) {
    case "list_accounts": {
      const accounts = getAccountBalances(db, input?.type ? { type: input.type } : {});
      if (accounts.length === 0) return "No accounts in the chart of accounts yet.";
      return accounts
        .map(a => {
          const meta: string[] = [];
          if (a.bank_name) meta.push(sanitizeForPrompt(a.bank_name));
          if (a.account_number_masked) meta.push(sanitizeForPrompt(a.account_number_masked));
          if (a.due_day) meta.push(`due day ${a.due_day}`);
          if (a.points_balance) meta.push(`${a.points_balance} pts`);
          const metaStr = meta.length ? ` [${meta.join(" · ")}]` : "";
          return `${a.id} | ${sanitizeForPromptCell(a.name)} | ${a.type}${a.subtype ? `/${a.subtype}` : ""} | balance ${formatTHB(a.balance)}${metaStr}`;
        })
        .join("\n");
    }
    case "save_memory": {
      saveMemory(db, input.content, input.category || "general");
      return `Saved memory: "${sanitizeForPrompt(input.content)}"`;
    }
    case "get_memories": {
      const memories = getMemories(db);
      if (memories.length === 0) return "No memories saved yet.";
      return memories
        .map(m => `[${m.category}] ${sanitizeForPrompt(m.content)} (saved ${m.created_at})`)
        .join("\n");
    }
    default:
      return undefined;
  }
}

export const commonTools: ToolModule = { DEFS, LABELS, execute };
