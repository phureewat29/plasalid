import type Database from "libsql";
import {
  findAccountById,
  getAccountBalances,
  getNetWorth,
  getPeriodTotals,
} from "../../db/queries/account-balance.js";
import { listPostings } from "../../db/queries/transactions.js";
import { listOpenQuestions } from "../../db/queries/questions.js";
import { searchPostings } from "../../db/queries/search.js";
import { formatAmount } from "../../currency.js";
import { sanitizeForPrompt, sanitizeForPromptCell } from "../sanitize.js";
import type {
  AgentExecutionContext,
  ToolDefinition,
  ToolModule,
} from "./types.js";

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
    description:
      "Compute current net worth: total assets minus total liabilities.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_postings",
    description:
      "List transaction postings filtered by account and/or date range.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" },
        q: {
          type: "string",
          description:
            "Free-text contains-match on description, memo, or merchant",
        },
        limit: { type: "number", description: "Max results (default 50)" },
      },
      required: [],
    },
  },
  {
    name: "search_transactions",
    description:
      "Free-text search across transaction descriptions, posting memos, account names, and merchant names.",
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
    description:
      "Get total income and total expense in a date range. Useful for monthly summaries.",
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
    name: "list_open_questions",
    description:
      "List clarification questions recorded by the scanner that have not been resolved yet. Each row carries the prompt, optional candidate answers, and the file/transaction/account it was attached to. The resolver uses this to drive the step-by-step clarification loop.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 50 },
        kind: {
          type: "string",
          description:
            "Optional filter by question kind (e.g. 'uncategorized_expense').",
        },
      },
      required: [],
    },
  },
];

const LABELS: Record<string, string> = {
  get_account_balance: "Looking up balance",
  get_net_worth: "Computing net worth",
  list_postings: "Listing postings",
  search_transactions: "Searching transactions",
  get_period_totals: "Summing period totals",
  list_open_questions: "Listing open questions",
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
      const bal = balances.find((b) => b.id === acct.id)?.balance ?? 0;
      return `${sanitizeForPrompt(acct.name)} (${acct.type}): ${formatAmount(bal)}`;
    }
    case "get_net_worth": {
      const nw = getNetWorth(db);
      return `Net worth: ${formatAmount(nw.net_worth)} (assets ${formatAmount(nw.assets)} − liabilities ${formatAmount(nw.liabilities)})`;
    }
    case "list_postings": {
      const rows = listPostings(db, {
        account_id: input.account_id,
        from: input.from,
        to: input.to,
        q: input.q,
        limit: input.limit,
      });
      if (rows.length === 0) return "No matching postings.";
      return rows
        .map((r) => {
          const dr = r.debit > 0 ? `DR ${formatAmount(r.debit)}` : "";
          const cr = r.credit > 0 ? `CR ${formatAmount(r.credit)}` : "";
          const merchant = r.merchant_name
            ? ` (${sanitizeForPromptCell(r.merchant_name)})`
            : "";
          return `${r.transaction_date} | ${sanitizeForPromptCell(r.transaction_description || "")}${merchant} | ${sanitizeForPromptCell(r.account_name || "")} | ${dr}${cr} | ${sanitizeForPromptCell(r.memo || "")}`;
        })
        .join("\n");
    }
    case "search_transactions": {
      const rows = searchPostings(db, input.query, input.limit);
      if (rows.length === 0)
        return `No matches for "${sanitizeForPrompt(input.query)}".`;
      return rows
        .map((r) => {
          const dr = r.debit > 0 ? `DR ${formatAmount(r.debit)}` : "";
          const cr = r.credit > 0 ? `CR ${formatAmount(r.credit)}` : "";
          const merchant = r.merchant_name
            ? ` (${sanitizeForPromptCell(r.merchant_name)})`
            : "";
          return `${r.transaction_date} | ${sanitizeForPromptCell(r.transaction_description || "")}${merchant} | ${sanitizeForPromptCell(r.account_name || "")} | ${dr}${cr}`;
        })
        .join("\n");
    }
    case "get_period_totals": {
      const totals = getPeriodTotals(db, input.from, input.to);
      return `Income ${formatAmount(totals.income)} · Expenses ${formatAmount(totals.expenses)} · Net ${formatAmount(totals.income - totals.expenses)}`;
    }
    case "list_open_questions": {
      const rows = listOpenQuestions(db, input.limit ?? 50);
      const filtered = input.kind
        ? rows.filter((r) => r.kind === input.kind)
        : rows;
      if (filtered.length === 0)
        return "No open questions. The picture is clear.";
      return filtered
        .map((r) => {
          const targets = [
            r.transaction_id ? `transaction=${r.transaction_id}` : null,
            r.account_id ? `account=${r.account_id}` : null,
            !r.transaction_id && !r.account_id && r.file_id
              ? `file=${r.file_id}`
              : null,
            r.kind ? `kind=${r.kind}` : null,
          ]
            .filter(Boolean)
            .join(" ");
          const options = r.options_json
            ? ` [options: ${(JSON.parse(r.options_json) as string[]).map((o) => sanitizeForPrompt(o)).join(" | ")}]`
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
