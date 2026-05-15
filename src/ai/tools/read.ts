import type Database from "libsql";
import {
  findAccountById,
  getAccountBalances,
  getNetWorth,
  getPeriodTotals,
} from "../../db/queries/account_balance.js";
import { listJournalLines } from "../../db/queries/journal.js";
import { listOpenConcerns } from "../../db/queries/concerns.js";
import { searchJournalLines } from "../../db/queries/search.js";
import { formatCurrencyAmount } from "../../currency.js";
import { sanitizeForPrompt, sanitizeForPromptCell } from "../sanitize.js";
import type { AgentExecutionContext, ToolDefinition, ToolModule } from "./types.js";

function formatTHB(amount: number): string {
  return formatCurrencyAmount(amount, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const DEFS: ToolDefinition[] = [
  {
    name: "get_account_balance",
    description: "Get balance for a single account by id.",
    input_schema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      required: ["account_id"],
    },
  },
  {
    name: "get_net_worth",
    description: "Compute current net worth: total assets minus total liabilities.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_journal_entries",
    description: "List journal lines filtered by account and/or date range.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" },
        q: { type: "string", description: "Free-text contains-match on description or memo" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
      required: [],
    },
  },
  {
    name: "search_transactions",
    description: "Free-text search across journal entry descriptions, line memos, and account names.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 30 },
      },
      required: ["query"],
    },
  },
  {
    name: "get_period_totals",
    description: "Get total income and total expense in a date range. Useful for monthly summaries.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "list_open_concerns",
    description: "List clarification requests recorded by the scanner that have not been resolved yet. Each row carries the prompt, optional candidate answers, and the file/entry/account it was attached to. The reviewer uses this to drive the step-by-step clarification loop.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 50 },
      },
      required: [],
    },
  },
];

const LABELS: Record<string, string> = {
  get_account_balance: "Looking up balance",
  get_net_worth: "Computing net worth",
  list_journal_entries: "Listing journal entries",
  search_transactions: "Searching transactions",
  get_period_totals: "Summing period totals",
  list_open_concerns: "Listing open concerns",
};

async function execute(
  db: Database.Database,
  name: string,
  input: any,
  _ctx: AgentExecutionContext | undefined,
): Promise<string | undefined> {
  switch (name) {
    case "get_account_balance": {
      const acct = findAccountById(db, input.account_id);
      if (!acct) return `Account "${input.account_id}" not found.`;
      const balances = getAccountBalances(db);
      const bal = balances.find(b => b.id === acct.id)?.balance ?? 0;
      return `${sanitizeForPrompt(acct.name)} (${acct.type}): ${formatTHB(bal)}`;
    }
    case "get_net_worth": {
      const nw = getNetWorth(db);
      return `Net worth: ${formatTHB(nw.net_worth)} (assets ${formatTHB(nw.assets)} − liabilities ${formatTHB(nw.liabilities)})`;
    }
    case "list_journal_entries": {
      const rows = listJournalLines(db, {
        account_id: input.account_id,
        from: input.from,
        to: input.to,
        q: input.q,
        limit: input.limit,
      });
      if (rows.length === 0) return "No matching journal lines.";
      return rows
        .map(r => {
          const dr = r.debit > 0 ? `DR ${formatTHB(r.debit)}` : "";
          const cr = r.credit > 0 ? `CR ${formatTHB(r.credit)}` : "";
          return `${r.entry_date} | ${sanitizeForPromptCell(r.entry_description)} | ${sanitizeForPromptCell(r.account_name || "")} | ${dr}${cr} | ${sanitizeForPromptCell(r.memo || "")}`;
        })
        .join("\n");
    }
    case "search_transactions": {
      const rows = searchJournalLines(db, input.query, input.limit);
      if (rows.length === 0) return `No matches for "${sanitizeForPrompt(input.query)}".`;
      return rows
        .map(r => {
          const dr = r.debit > 0 ? `DR ${formatTHB(r.debit)}` : "";
          const cr = r.credit > 0 ? `CR ${formatTHB(r.credit)}` : "";
          return `${r.entry_date} | ${sanitizeForPromptCell(r.entry_description)} | ${sanitizeForPromptCell(r.account_name || "")} | ${dr}${cr}`;
        })
        .join("\n");
    }
    case "get_period_totals": {
      const totals = getPeriodTotals(db, input.from, input.to);
      return `Income ${formatTHB(totals.income)} · Expenses ${formatTHB(totals.expenses)} · Net ${formatTHB(totals.income - totals.expenses)}`;
    }
    case "list_open_concerns": {
      const rows = listOpenConcerns(db, input.limit ?? 50);
      if (rows.length === 0) return "No open concerns. The picture is clear.";
      return rows
        .map(r => {
          const targets = [
            r.entry_id ? `entry=${r.entry_id}` : null,
            r.account_id ? `account=${r.account_id}` : null,
            !r.entry_id && !r.account_id && r.file_id ? `file=${r.file_id}` : null,
          ].filter(Boolean).join(" ");
          const options = r.options_json
            ? ` [options: ${(JSON.parse(r.options_json) as string[]).map(o => sanitizeForPrompt(o)).join(" | ")}]`
            : "";
          return `${r.id} ${targets} — ${sanitizeForPrompt(r.prompt)}${options}`;
        })
        .join("\n");
    }
    default:
      return undefined;
  }
}

export const readTools: ToolModule = { DEFS, LABELS, execute };
