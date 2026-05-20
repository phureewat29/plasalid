import type Database from "libsql";
import {
  findAccountById,
  findAccountsByFuzzyName,
  getAccountBalances,
  ensureStructuralAccount,
  renameAccount,
  deleteAccount,
} from "../../db/queries/account-balance.js";
import {
  validateTransaction,
  insertTransactionRows,
  type TransactionInput,
} from "../../db/queries/transactions.js";
import { appendAction } from "../../db/queries/action-log.js";
import { formatAmount } from "../../currency.js";
import { sanitizeForPrompt } from "../sanitize.js";
import type {
  AgentExecutionContext,
  ToolDefinition,
  ToolModule,
} from "./types.js";

const EQUITY_ADJUST_ID = "equity:adjustments";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Record-only tool definitions
 *
 * `find_similar_accounts` and `clarify` are reads / prompts; `adjust_account_balance`,
 * `rename_account`, and `delete_account` mutate the DB. Of those, only
 * `adjust_account_balance` writes an action_log row (with `action_type='adjust_balance'`);
 * rename and delete are simple shape changes without an audit entry.
 */

const DEFS: ToolDefinition[] = [
  {
    name: "find_similar_accounts",
    description:
      "Find existing accounts whose name fuzzy-matches a candidate. Always call this before create_account when the user names an account (e.g. 'my ttb saving', 'SET portfolio') so you don't create a duplicate. Returns the top matches with similarity scores; if the highest score is >= 0.7 and it isn't an exact id hit, call clarify to confirm with the user before creating a new one.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text name to match against the chart of accounts.",
        },
        threshold: {
          type: "number",
          description: "Minimum similarity (0-1). Default 0.5.",
          default: 0.5,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "adjust_account_balance",
    description:
      "Move an account's current balance to `target_balance` by posting a balancing transaction against the equity:adjustments account. Use this when the user states a balance ('my SET portfolio is now 1.8MB', '500k networth in my Diem Investment') rather than a transaction. Reads the account's current balance, computes the delta, posts a 2-posting transaction with the right debit/credit sides for the account type, and creates equity:adjustments on demand if it doesn't exist. Currency follows the account.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        target_balance: {
          type: "number",
          description:
            "The new desired balance in the account's currency, in natural sign (positive).",
        },
        reason: {
          type: "string",
          description:
            "Short description, e.g. 'Set DIEM portfolio to current market value (user-asserted).'.",
        },
        date: {
          type: "string",
          description: "ISO YYYY-MM-DD. Defaults to today.",
        },
      },
      required: ["account_id", "target_balance", "reason"],
    },
  },
  {
    name: "rename_account",
    description:
      "Rename an existing account. Postings and metadata are untouched. Use for utterances like 'rename SCB to Bangkok Bank' once the user-named account is resolved via find_similar_accounts.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        name: { type: "string" },
      },
      required: ["account_id", "name"],
    },
  },
  {
    name: "delete_account",
    description:
      "Delete an account that has no postings and no children. Use for utterances like 'delete my old empty cash account'. Refuses if the account still has postings (merge into another account first) or child accounts (delete or re-parent the children first).",
    input_schema: {
      type: "object",
      properties: { account_id: { type: "string" } },
      required: ["account_id"],
    },
  },
  {
    name: "clarify",
    description:
      "Ask the user a clarifying question and return their answer as a string. Use when the utterance is ambiguous (multiple matching accounts, missing amount, unclear date, can't tell expense vs transfer, plan confirmation before a multi-step action). Unlike resolve's ask_user, this does NOT write to the unknowns table — record-time questions are transient.",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The question to ask in plain language.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of candidate answers.",
        },
        facts: {
          type: "object",
          description:
            "Optional structured highlights rendered as a single colored header line above the question. amount=yellow, date=cyan, merchant=green, accounts=magenta.",
          properties: {
            amount: { type: "string" },
            date: { type: "string" },
            merchant: { type: "string" },
            accounts: { type: "array", items: { type: "string" } },
          },
        },
      },
      required: ["prompt"],
    },
  },
];

const LABELS: Record<string, string> = {
  find_similar_accounts: "Searching similar accounts",
  adjust_account_balance: "Adjusting balance",
  rename_account: "Renaming account",
  delete_account: "Deleting account",
  clarify: "Asking for clarification",
};

async function execute(
  db: Database.Database,
  name: string,
  input: any,
  ctx: AgentExecutionContext | undefined,
): Promise<string | undefined> {
  switch (name) {
    case "find_similar_accounts": {
      const matches = findAccountsByFuzzyName(
        db,
        String(input.query ?? ""),
        input.threshold,
      );
      if (matches.length === 0)
        return `No accounts matched "${sanitizeForPrompt(input.query ?? "")}".`;
      return matches
        .slice(0, 8)
        .map(
          (m) =>
            `${m.account.id} | ${sanitizeForPrompt(m.account.name)} | ${m.account.type}${m.account.subtype ? `/${m.account.subtype}` : ""} | similarity ${m.similarity}`,
        )
        .join("\n");
    }

    case "adjust_account_balance":
      return adjustAccountBalance(db, input, ctx);

    case "rename_account": {
      const changed = renameAccount(db, input.account_id, input.name);
      return changed === 0
        ? `Account ${input.account_id} not found.`
        : `Renamed ${input.account_id} → "${sanitizeForPrompt(input.name)}".`;
    }

    case "delete_account": {
      try {
        deleteAccount(db, input.account_id);
        return `Deleted account ${input.account_id}.`;
      } catch (err: any) {
        return `Could not delete: ${err.message}`;
      }
    }

    case "clarify": {
      if (!ctx) return "clarify is only available inside an agent session.";
      if (!ctx.interactive || !ctx.promptUser) {
        return `Awaiting user input — cannot proceed in non-interactive mode. Question was: ${sanitizeForPrompt(input.prompt)}`;
      }
      const answer = await ctx.promptUser(
        input.prompt,
        input.options,
        input.facts,
      );
      return `User answered: ${sanitizeForPrompt(answer)}`;
    }

    default:
      return undefined;
  }
}

async function adjustAccountBalance(
  db: Database.Database,
  input: any,
  ctx: AgentExecutionContext | undefined,
): Promise<string> {
  if (!ctx)
    return "adjust_account_balance is only available inside an agent session.";

  const account = findAccountById(db, input.account_id);
  if (!account) return `Account "${input.account_id}" not found.`;

  const target = Number(input.target_balance);
  if (!Number.isFinite(target))
    return `target_balance must be a number, got ${JSON.stringify(input.target_balance)}.`;

  const balances = getAccountBalances(db);
  const current = balances.find((b) => b.id === account.id)?.balance ?? 0;
  const delta = round2(target - current);
  if (delta === 0) {
    return `${sanitizeForPrompt(account.name)} is already at ${formatAmount(target)}; no transaction posted.`;
  }

  const amount = Math.abs(delta);
  const debitNormal = account.type === "asset" || account.type === "expense";
  const debitAccountId =
    (debitNormal && delta > 0) || (!debitNormal && delta < 0)
      ? account.id
      : EQUITY_ADJUST_ID;
  const creditAccountId =
    debitAccountId === account.id ? EQUITY_ADJUST_ID : account.id;

  const date =
    input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date)
      ? input.date
      : todayIso();
  const reason = String(input.reason || "Balance adjustment").trim();
  const currency = account.currency || "THB";

  const txInput: TransactionInput = {
    date,
    description: reason,
    postings: [
      { account_id: debitAccountId, debit: amount, currency },
      { account_id: creditAccountId, credit: amount, currency },
    ],
  };

  let validated: TransactionInput & { id: string };
  try {
    validated = validateTransaction(txInput);
  } catch (err: any) {
    return `Could not build adjustment transaction: ${err.message}`;
  }

  try {
    const tx = db.transaction((): void => {
      const equityExisted = !!findAccountById(db, EQUITY_ADJUST_ID);
      if (!equityExisted) {
        ensureStructuralAccount(db, "equity:adjustments");
        if (ctx.correlationId) {
          appendAction(db, {
            correlation_id: ctx.correlationId,
            command: ctx.command ?? "record",
            user_input: ctx.userInput ?? null,
            action_type: "create_account",
            target_id: EQUITY_ADJUST_ID,
            payload: { row: findAccountById(db, EQUITY_ADJUST_ID) },
          });
        }
      }
      insertTransactionRows(db, validated);
      if (ctx.correlationId) {
        appendAction(db, {
          correlation_id: ctx.correlationId,
          command: ctx.command ?? "record",
          user_input: ctx.userInput ?? null,
          action_type: "adjust_balance",
          target_id: validated.id,
          payload: {
            account_id: account.id,
            before_balance: current,
            after_balance: target,
            transaction: {
              date: validated.date,
              description: validated.description,
            },
            postings: validated.postings,
          },
        });
      }
    });
    tx();
  } catch (err: any) {
    return `Could not post adjustment transaction: ${err.message}`;
  }

  return `Adjusted ${sanitizeForPrompt(account.name)}: ${formatAmount(current)} → ${formatAmount(target)} (Δ ${delta > 0 ? "+" : ""}${formatAmount(delta)}). Transaction ${validated.id}.`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const recordTools: ToolModule = { DEFS, LABELS, execute };
