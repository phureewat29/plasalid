import type Database from "libsql";
import {
  createAccount,
  updateAccountMetadata,
  findAccountById,
} from "../../db/queries/account_balance.js";
import {
  validateTransaction,
  insertTransactionRows,
  recordTransaction,
} from "../../db/queries/transactions.js";
import { appendAction } from "../../db/queries/action_log.js";
import {
  getConcernTarget,
  recordConcern,
  resolveConcern,
} from "../../db/queries/concerns.js";
import { runExclusive as runAccountExclusive } from "../../scanner/account_mutex.js";
import { sanitizeForPrompt } from "../sanitize.js";
import { ACCOUNT_TYPE_DESCRIPTIONS } from "../../accounts/taxonomy.js";
import type { AgentExecutionContext, ToolDefinition, ToolModule } from "./types.js";

const ACCOUNT_TYPES = Object.keys(ACCOUNT_TYPE_DESCRIPTIONS);

/**
 * Account + transaction write primitives
 *
 * Shared by scan, review, and record. Each tool branches once on
 * `ctx.correlationId`: when set (record path), the data write and the
 * action_log insert run inside a single transaction so the audit row is
 * atomic with the change. Without it (scan / review), the write goes through
 * the existing path unchanged.
 */

const ACCOUNT_DEFS: ToolDefinition[] = [
  {
    name: "create_account",
    description:
      "Create a new account in the chart of accounts. Account ids are colon-paths under one of the five top-level type roots ('asset', 'liability', 'income', 'expense', 'equity'). Examples: 'asset:kbank-savings-1234', 'expense:food', 'expense:food:groceries'. Every non-root account must have a parent_id that already exists and shares its type; create intermediate parents (e.g. 'expense:food') before their leaves. Top-level roots are auto-bootstrapped on first use.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Stable colon-path identifier, lowercase. e.g. 'expense:food:groceries' or 'asset:kbank-savings-1234'." },
        name: { type: "string", description: "Human-readable name. e.g. 'Groceries' or 'KBank Savings ••1234'." },
        type: { type: "string", enum: ACCOUNT_TYPES, description: "Account type. Must match the parent's type." },
        parent_id: {
          type: ["string", "null"],
          description: "Parent account id (the prefix before the final ':' segment). Pass null only when creating one of the five top-level type roots — and then id must equal type. Examples: id='expense:food:groceries' → parent_id='expense:food'. id='expense:food' → parent_id='expense'. id='expense' → parent_id=null.",
        },
        subtype: { type: "string", description: "e.g. 'bank', 'credit_card', 'salary'." },
        bank_name: { type: "string", description: "Thai institution code from the taxonomy (e.g. KBANK, SCB, KTC)." },
        account_number_masked: { type: "string", description: "Last 4 digits only, e.g. '••1234'." },
        currency: { type: "string", description: "ISO 4217 code. Defaults to 'THB'.", default: "THB" },
        due_day: { type: "number", description: "Credit-card due day of month (liabilities only)." },
        statement_day: { type: "number", description: "Statement-cut day of month." },
        metadata: { type: "object", description: "Free-form extra fields (e.g. {points_program: 'KTC Forever'})." },
      },
      required: ["id", "name", "type", "parent_id"],
    },
  },
  {
    name: "update_account_metadata",
    description: "Update account metadata (due day, statement day, points balance, masked number, bank). Use this — not record_transaction — when the user says things like 'set my KTC due day to 20' or 'statement day 28'.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        due_day: { type: "number" },
        statement_day: { type: "number" },
        points_balance: { type: "number" },
        account_number_masked: { type: "string" },
        bank_name: { type: "string" },
        metadata: { type: "object", description: "Merged into existing metadata_json." },
      },
      required: ["account_id"],
    },
  },
  {
    name: "record_transaction",
    description:
      "Post one balanced double-entry transaction — the right tool for any real-world event (purchase, payment, transfer, refund, salary, withdrawal). Use adjust_account_balance instead when the user is stating a current balance rather than describing a transaction. The sum of debits MUST equal the sum of credits (within one currency). Convert Buddhist-Era dates by subtracting 543. Each posting carries an ISO 4217 currency code (THB, USD, EUR, …); default to THB. Use the account's currency where set; only deviate when the source row is explicitly in another currency. When the transaction has an external counter-party, attach a `merchant` block — Plasalid dedups merchants and learns a default expense account per merchant so future statements skip re-categorization.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "ISO Gregorian date (YYYY-MM-DD)." },
        description: { type: "string", description: "Short human-readable description." },
        source_page: { type: "number", description: "Page number in the source PDF, if known." },
        raw_descriptor: {
          type: "string",
          description: "The exact statement line (the raw merchant descriptor) when posting from a PDF — preserved for alias matching and later review. Omit for manual entries and transfers.",
        },
        merchant: {
          type: "object",
          description: "Counter-party block. Omit for transfers between own accounts and pure metadata movements. When set during a scan, Plasalid upserts the merchant by canonical_name and (optionally) records the raw descriptor as an alias for future matches. Set default_account_id to teach the cache when categorization is confident.",
          properties: {
            canonical_name: { type: "string", description: "Normalized merchant name, Title Case. e.g. 'Starbucks', 'Amazon', 'Spotify'." },
            alias: { type: "string", description: "The raw descriptor exactly as it appears on the statement. Plasalid normalizes and stores it so future statements skip the LLM." },
            default_account_id: { type: "string", description: "Optional learned cache: 'this merchant's expense category is X'. Set when categorization is confident." },
          },
          required: ["canonical_name"],
        },
        merchant_id: {
          type: "string",
          description: "Pre-resolved merchant id (from the scanner's alias pre-pass). When set, the merchant block is ignored. The scanner uses this to skip re-categorizing merchants it already knows.",
        },
        postings: {
          type: "array",
          description: "Two or more postings that balance.",
          items: {
            type: "object",
            properties: {
              account_id: { type: "string", description: "Existing account id from list_accounts or create_account." },
              debit: { type: "number", description: "Debit amount in this posting's currency. Use 0 if this posting is a credit." },
              credit: { type: "number", description: "Credit amount in this posting's currency. Use 0 if this posting is a debit." },
              currency: { type: "string", description: "ISO 4217 currency code for this posting (e.g. THB, USD, EUR). Defaults to THB.", default: "THB" },
              memo: { type: "string", description: "Optional per-posting memo." },
            },
            required: ["account_id"],
          },
        },
      },
      required: ["date", "description", "postings"],
    },
  },
];

const ACCOUNT_LABELS: Record<string, string> = {
  create_account: "Creating account",
  update_account_metadata: "Updating account metadata",
  record_transaction: "Posting transaction",
};

async function accountExecute(
  db: Database.Database,
  name: string,
  input: any,
  ctx: AgentExecutionContext | undefined,
): Promise<string | undefined> {
  switch (name) {
    case "create_account": {
      if (ctx?.dryRun) return `Would create account ${input.id}.`;
      if (!ACCOUNT_TYPES.includes(input.type)) {
        return `Invalid type "${input.type}". Allowed: ${ACCOUNT_TYPES.join(", ")}.`;
      }
      return await runAccountExclusive(() => {
        try {
          const create = () => {
            createAccount(db, {
              id: input.id,
              name: input.name,
              type: input.type,
              parent_id: input.parent_id ?? null,
              subtype: input.subtype ?? null,
              bank_name: input.bank_name ?? null,
              account_number_masked: input.account_number_masked ?? null,
              currency: input.currency,
              due_day: input.due_day ?? null,
              statement_day: input.statement_day ?? null,
              metadata: input.metadata ?? null,
            });
          };
          if (ctx?.correlationId) {
            const tx = db.transaction((): void => {
              create();
              const row = findAccountById(db, input.id);
              appendAction(db, {
                correlation_id: ctx.correlationId!,
                command: ctx.command ?? "record",
                user_input: ctx.userInput ?? null,
                action_type: "create_account",
                target_id: input.id,
                payload: { row },
              });
            });
            tx();
          } else {
            create();
          }
          return `Account created: ${input.id} (${input.name}, ${input.type}).`;
        } catch (err: any) {
          if (err.code === "ACCOUNT_EXISTS") {
            return `Account "${input.id}" already exists. Use update_account_metadata to modify it.`;
          }
          return `Could not create account "${input.id}": ${err.message}`;
        }
      });
    }

    case "update_account_metadata": {
      if (ctx?.dryRun) return `Would update metadata for ${input.account_id}: ${JSON.stringify(input)}`;
      return await runAccountExclusive(() => {
        try {
          let changed = false;
          const apply = () => {
            const result = updateAccountMetadata(db, input.account_id, {
              due_day: input.due_day,
              statement_day: input.statement_day,
              points_balance: input.points_balance,
              account_number_masked: input.account_number_masked,
              bank_name: input.bank_name,
              metadata: input.metadata,
            });
            changed = result.changed;
            return result;
          };
          if (ctx?.correlationId) {
            const tx = db.transaction((): void => {
              const result = apply();
              if (!result.changed) return;
              appendAction(db, {
                correlation_id: ctx.correlationId!,
                command: ctx.command ?? "record",
                user_input: ctx.userInput ?? null,
                action_type: "update_account_metadata",
                target_id: input.account_id,
                payload: { before: result.before, after: result.after },
              });
            });
            tx();
          } else {
            apply();
          }
          return changed ? `Updated ${input.account_id}.` : "Nothing to update.";
        } catch (err: any) {
          if (String(err.message).includes("not found")) {
            return `Account "${input.account_id}" not found.`;
          }
          throw err;
        }
      });
    }

    case "record_transaction": {
      if (!ctx) return "record_transaction is only available inside an agent session.";
      if (ctx.dryRun) return `Would post transaction "${input.description}" on ${input.date}.`;
      const txInput = {
        date: input.date,
        description: input.description,
        source_file_id: ctx.fileId,
        source_page: input.source_page ?? null,
        raw_descriptor: input.raw_descriptor ?? null,
        merchant: input.merchant ?? null,
        merchant_id: input.merchant_id ?? null,
        postings: (input.postings || []).map((p: any) => ({
          account_id: p.account_id,
          debit: p.debit ?? 0,
          credit: p.credit ?? 0,
          currency: p.currency || "THB",
          memo: p.memo ?? null,
        })),
      };
      try {
        let transactionId: string;
        if (ctx.buffer) {
          transactionId = ctx.buffer.appendTransaction(txInput);
        } else if (ctx.correlationId) {
          const validated = validateTransaction(txInput);
          const tx = db.transaction((): void => {
            insertTransactionRows(db, validated);
            appendAction(db, {
              correlation_id: ctx.correlationId!,
              command: ctx.command ?? "record",
              user_input: ctx.userInput ?? null,
              action_type: "record_transaction",
              target_id: validated.id,
              payload: {
                transaction: {
                  date: validated.date,
                  description: validated.description,
                  source_page: validated.source_page ?? null,
                  raw_descriptor: validated.raw_descriptor ?? null,
                },
                postings: validated.postings,
              },
            });
          });
          tx();
          transactionId = validated.id;
        } else {
          transactionId = recordTransaction(db, txInput);
        }
        return `Posted transaction ${transactionId} (${input.date}).`;
      } catch (err: any) {
        return `Could not post transaction: ${err.message}`;
      }
    }

    default:
      return undefined;
  }
}

export const accountIngestTools: ToolModule = {
  DEFS: ACCOUNT_DEFS,
  LABELS: ACCOUNT_LABELS,
  execute: accountExecute,
};

/**
 * Scan-only concerns
 *
 * `note_concern` records a clarification mid-scan without ever prompting the
 * user — only scan needs this. Record uses `clarify` (transient prompt, no
 * concerns-table residue); review uses `ask_user` (prompts and resolves).
 */

const CONCERN_DEFS: ToolDefinition[] = [
  {
    name: "note_concern",
    description:
      "Record a clarification request without pausing the run. Use during scan when a row is ambiguous (post your best-guess transaction first, then call this with the transaction's id), when a row is unparseable (skip the transaction, call this with no transaction_id), or when you have a concern about an account itself (pass account_id). Use kind='uncategorized_expense' when posting an expense to expense:uncategorized so reviewer can group these. The reviewer picks these up later with the full picture.",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The question or concern in a complete sentence, with date, ฿-formatted amount, and human account names. Never reference internal ids.",
        },
        kind: {
          type: "string",
          description: "Optional category for the concern. Use 'uncategorized_expense' when the posting landed in expense:uncategorized; reviewer batches these into one cleanup pass.",
        },
        options: {
          type: "array",
          description: "Optional list of candidate answers the reviewer can offer the user.",
          items: { type: "string" },
        },
        transaction_id: {
          type: "string",
          description: "Id of the transaction this concern relates to (returned by record_transaction). Omit for file-level concerns about an unparseable row.",
        },
        account_id: {
          type: "string",
          description: "Id of the account this concern relates to. Set when the statement's bank name, currency, statement_day, due_day, or other metadata disagrees with the stored account, or when you suspect a new account you're about to create duplicates an existing one. Can be combined with transaction_id.",
        },
      },
      required: ["prompt"],
    },
  },
];

const CONCERN_LABELS: Record<string, string> = {
  note_concern: "Noting concern",
};

async function concernExecute(
  db: Database.Database,
  name: string,
  input: any,
  ctx: AgentExecutionContext | undefined,
): Promise<string | undefined> {
  if (name !== "note_concern") return undefined;
  if (!ctx) return "note_concern is only available inside an agent session.";
  const target = {
    transaction_id: input.transaction_id ?? null,
    account_id: input.account_id ?? null,
  };
  if (ctx.buffer) {
    ctx.buffer.appendConcern({ ...target, kind: input.kind ?? null, prompt: input.prompt, options: input.options });
    return `Concern noted (buffered). Continue with the next row.`;
  }
  const id = recordConcern(db, {
    file_id: ctx.fileId ?? null,
    transaction_id: target.transaction_id,
    account_id: target.account_id,
    kind: input.kind ?? null,
    prompt: input.prompt,
    options: input.options,
  });
  return `Concern noted (${id}). Continue with the next row.`;
}

export const scanConcernTools: ToolModule = {
  DEFS: CONCERN_DEFS,
  LABELS: CONCERN_LABELS,
  execute: concernExecute,
};

/**
 * Review-only tool definitions
 *
 * `ask_user` is the only interactive primitive. Scan never reaches it (the
 * scan profile doesn't include this module), so we don't need a "scan, please
 * don't use this" guard.
 */

const REVIEW_DEFS: ToolDefinition[] = [
  {
    name: "ask_user",
    description:
      "Ask the user a clarifying question when you cannot confidently proceed. The pipeline pauses and prompts the user interactively. Available during `plasalid review`. Not exposed during `plasalid scan` — use `note_concern` instead. Pass `transaction_id` / `account_id` to attach the question to the same target as a scan-noted concern. Pass `concern_id` to resolve an existing open concern in place (recommended when re-posing a scan-noted concern to the user). Pass `related_concern_ids` to apply the user's single answer to a whole group of sibling concerns at once.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The question to ask in plain language." },
        options: {
          type: "array",
          description: "Optional list of candidate answers.",
          items: { type: "string" },
        },
        transaction_id: {
          type: "string",
          description: "Optional: transaction this question is about. Used to clear the transaction's has_concern flag once all its concerns close.",
        },
        account_id: {
          type: "string",
          description: "Optional: account this question is about. Used to clear the account's has_concern flag once all its concerns close.",
        },
        concern_id: {
          type: "string",
          description: "Optional: id of an existing open concern. If supplied, the user's answer resolves that row in place instead of creating a new one.",
        },
        related_concern_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional: ids of additional open concerns that share the same answer as `concern_id`. The user is prompted once; every listed concern (plus the primary) is marked resolved with the same answer. Use this for grouping duplicate questions — e.g., 12 Lazada rows that all categorize the same way — so the user isn't asked the same thing twelve times.",
        },
        facts: {
          type: "object",
          description: "Optional structured highlights rendered as a single colored header line above the question. Provide whichever fields apply; the prompter colorizes each by category (amount=yellow, date=cyan, merchant=green, accounts=magenta). Keep the `prompt` text short — the facts header carries the context.",
          properties: {
            amount: { type: "string", description: "฿-formatted amount, e.g. '฿1,200.00'." },
            date: { type: "string", description: "ISO date or short range, e.g. '2026-04-15' or '2026-02-15 to 2026-05-15'." },
            merchant: { type: "string", description: "Counterparty / merchant name, e.g. 'LAZADA TH', 'Spotify'." },
            accounts: {
              type: "array",
              items: { type: "string" },
              description: "Human account names involved. For merges, list the survivor first.",
            },
          },
        },
      },
      required: ["prompt"],
    },
  },
];

const REVIEW_LABELS: Record<string, string> = {
  ask_user: "Asking for clarification",
};

async function reviewExecute(
  db: Database.Database,
  name: string,
  input: any,
  ctx: AgentExecutionContext | undefined,
): Promise<string | undefined> {
  if (name !== "ask_user") return undefined;
  if (!ctx) return "ask_user is only available inside an agent session.";

  let id: string;
  if (input.concern_id) {
    id = String(input.concern_id);
    if (!getConcernTarget(db, id)) return `Concern ${id} not found.`;
  } else {
    id = recordConcern(db, {
      file_id: ctx.fileId ?? null,
      transaction_id: input.transaction_id ?? null,
      account_id: input.account_id ?? null,
      prompt: input.prompt,
      options: input.options,
    });
  }

  if (ctx.interactive && ctx.promptUser) {
    const answer = await ctx.promptUser(input.prompt, input.options, input.facts);
    resolveConcern(db, id, answer);
    const siblings: string[] = Array.isArray(input.related_concern_ids) ? input.related_concern_ids : [];
    let propagated = 0;
    for (const sibId of siblings) {
      if (sibId === id) continue;
      if (resolveConcern(db, String(sibId), answer)) propagated++;
    }
    const totalResolved = 1 + propagated;
    return `User answered: ${sanitizeForPrompt(answer)}${totalResolved > 1 ? ` (applied to ${totalResolved} concern${totalResolved === 1 ? "" : "s"})` : ""}`;
  }
  return `Question recorded for later (${id}). Awaiting user input — do not act on assumptions about this answer.`;
}

export const reviewIngestTools: ToolModule = {
  DEFS: REVIEW_DEFS,
  LABELS: REVIEW_LABELS,
  execute: reviewExecute,
};
