import type Database from "libsql";
import {
  createAccount,
  updateAccountMetadata,
  findAccountById,
} from "../../db/queries/account-balance.js";
import {
  validateTransaction,
  insertTransactionRows,
  recordTransaction,
} from "../../db/queries/transactions.js";
import { appendAction, type ActionType } from "../../db/queries/action-log.js";
import { recordUnknown } from "../../db/queries/unknowns.js";
import { runExclusive as runAccountExclusive } from "../../scanner/account-mutex.js";
import { ACCOUNT_TYPE_DESCRIPTIONS } from "../../accounts/taxonomy.js";
import type {
  AgentExecutionContext,
  ToolDefinition,
  ToolModule,
} from "./types.js";

const ACCOUNT_TYPES = Object.keys(ACCOUNT_TYPE_DESCRIPTIONS);

const BATCH_MAX = 50;

const TRANSACTION_ITEM_SCHEMA = {
  type: "object",
  properties: {
    date: {
      type: "string",
      description: "ISO Gregorian date (YYYY-MM-DD).",
    },
    description: {
      type: "string",
      description: "Short human-readable description.",
    },
    source_page: {
      type: "number",
      description: "Page number in the source PDF, if known.",
    },
    raw_descriptor: {
      type: "string",
      description:
        "The exact statement line (the raw merchant descriptor) when posting from a PDF — preserved for alias matching and later review.",
    },
    merchant: {
      type: "object",
      description:
        "Counter-party block. Omit for transfers between own accounts and pure metadata movements.",
      properties: {
        canonical_name: {
          type: "string",
          description: "Normalized merchant name, Title Case.",
        },
        alias: {
          type: "string",
          description: "The raw descriptor exactly as it appears on the statement.",
        },
        default_account_id: {
          type: "string",
          description: "Optional learned cache; do not set on first sight.",
        },
      },
      required: ["canonical_name"],
    },
    merchant_id: {
      type: "string",
      description: "Pre-resolved merchant id (from the scanner's alias pre-pass).",
    },
    postings: {
      type: "array",
      description: "Two or more postings that balance.",
      items: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          debit: { type: "number" },
          credit: { type: "number" },
          currency: { type: "string", default: "THB" },
          memo: { type: "string" },
        },
        required: ["account_id"],
      },
    },
  },
  required: ["date", "description", "postings"],
} as const;

/**
 * Account + transaction write primitives
 *
 * Shared by scan, resolve, and record. Each tool branches once on
 * `ctx.correlationId`: when set (record path), the data write and the
 * action_log insert run inside a single transaction so the audit row is
 * atomic with the change. Without it (scan / resolve), the write goes through
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
        id: {
          type: "string",
          description:
            "Stable colon-path identifier, lowercase. e.g. 'expense:food:groceries' or 'asset:kbank-savings-1234'.",
        },
        name: {
          type: "string",
          description:
            "Human-readable name. e.g. 'Groceries' or 'KBank Savings ••1234'.",
        },
        type: {
          type: "string",
          enum: ACCOUNT_TYPES,
          description: "Account type. Must match the parent's type.",
        },
        parent_id: {
          type: ["string", "null"],
          description:
            "Parent account id (the prefix before the final ':' segment). Pass null only when creating one of the five top-level type roots — and then id must equal type. Examples: id='expense:food:groceries' → parent_id='expense:food'. id='expense:food' → parent_id='expense'. id='expense' → parent_id=null.",
        },
        subtype: {
          type: "string",
          description: "e.g. 'bank', 'credit_card', 'salary'.",
        },
        bank_name: {
          type: "string",
          description:
            "Thai institution code from the taxonomy (e.g. KBANK, SCB, KTC).",
        },
        account_number_masked: {
          type: "string",
          description: "Last 4 digits only, e.g. '••1234'.",
        },
        currency: {
          type: "string",
          description: "ISO 4217 code. Defaults to 'THB'.",
          default: "THB",
        },
        due_day: {
          type: "number",
          description: "Credit-card due day of month (liabilities only).",
        },
        statement_day: {
          type: "number",
          description: "Statement-cut day of month.",
        },
        metadata: {
          type: "object",
          description:
            "Free-form extra fields (e.g. {points_program: 'KTC Forever'}).",
        },
      },
      required: ["id", "name", "type", "parent_id"],
    },
  },
  {
    name: "update_account_metadata",
    description:
      "Update account metadata (due day, statement day, points balance, masked number, bank). Use this — not record_transaction — when the user says things like 'set my KTC due day to 20' or 'statement day 28'.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "string" },
        due_day: { type: "number" },
        statement_day: { type: "number" },
        points_balance: { type: "number" },
        account_number_masked: { type: "string" },
        bank_name: { type: "string" },
        metadata: {
          type: "object",
          description: "Merged into existing metadata_json.",
        },
      },
      required: ["account_id"],
    },
  },
  {
    name: "record_transactions",
    description: `Post many balanced double-entry transactions in a single tool call. **Strongly preferred over record_transaction whenever you have more than one row to post** — the scan tool-step budget is finite (100 per file) and the singular form burns one step per row. Each item has the same shape as record_transaction. Validation runs per item: valid items are buffered and their ids returned; invalid items are reported back so you can fix and retry just those indices. Limit each call to ≤${BATCH_MAX} transactions; chunk larger statements across multiple calls.`,
    input_schema: {
      type: "object",
      properties: {
        transactions: {
          type: "array",
          description: `Up to ${BATCH_MAX} transactions; each has the same shape as record_transaction.`,
          items: TRANSACTION_ITEM_SCHEMA,
          minItems: 1,
          maxItems: BATCH_MAX,
        },
      },
      required: ["transactions"],
    },
  },
  {
    name: "record_transaction",
    description:
      "Post ONE balanced double-entry transaction. Prefer record_transactions (plural) when posting more than one row at a time — it burns one tool step instead of N. Use this singular form for one-off corrections (e.g. retrying a single failed item from a batch). The sum of debits MUST equal the sum of credits (within one currency). Convert Buddhist-Era dates by subtracting 543. Each posting carries an ISO 4217 currency code (THB, USD, EUR, …); default to THB. Use the account's currency where set; only deviate when the source row is explicitly in another currency. When the transaction has an external counter-party, attach a `merchant` block — Plasalid dedups merchants and learns a default expense account per merchant so future statements skip re-categorization.",
    input_schema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "ISO Gregorian date (YYYY-MM-DD).",
        },
        description: {
          type: "string",
          description: "Short human-readable description.",
        },
        source_page: {
          type: "number",
          description: "Page number in the source PDF, if known.",
        },
        raw_descriptor: {
          type: "string",
          description:
            "The exact statement line (the raw merchant descriptor) when posting from a PDF — preserved for alias matching and later review. Omit for manual entries and transfers.",
        },
        merchant: {
          type: "object",
          description:
            "Counter-party block. Omit for transfers between own accounts and pure metadata movements. When set during a scan, Plasalid upserts the merchant by canonical_name and (optionally) records the raw descriptor as an alias for future matches. Set default_account_id to teach the cache when categorization is confident.",
          properties: {
            canonical_name: {
              type: "string",
              description:
                "Normalized merchant name, Title Case. e.g. 'Starbucks', 'Amazon', 'Spotify'.",
            },
            alias: {
              type: "string",
              description:
                "The raw descriptor exactly as it appears on the statement. Plasalid normalizes and stores it so future statements skip the LLM.",
            },
            default_account_id: {
              type: "string",
              description:
                "Optional learned cache: 'this merchant's expense category is X'. Set when categorization is confident.",
            },
          },
          required: ["canonical_name"],
        },
        merchant_id: {
          type: "string",
          description:
            "Pre-resolved merchant id (from the scanner's alias pre-pass). When set, the merchant block is ignored. The scanner uses this to skip re-categorizing merchants it already knows.",
        },
        postings: {
          type: "array",
          description: "Two or more postings that balance.",
          items: {
            type: "object",
            properties: {
              account_id: {
                type: "string",
                description:
                  "Existing account id from list_accounts or create_account.",
              },
              debit: {
                type: "number",
                description:
                  "Debit amount in this posting's currency. Use 0 if this posting is a credit.",
              },
              credit: {
                type: "number",
                description:
                  "Credit amount in this posting's currency. Use 0 if this posting is a debit.",
              },
              currency: {
                type: "string",
                description:
                  "ISO 4217 currency code for this posting (e.g. THB, USD, EUR). Defaults to THB.",
                default: "THB",
              },
              memo: {
                type: "string",
                description: "Optional per-posting memo.",
              },
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
  record_transactions: "Posting transactions",
};

interface AuditRecord {
  actionType: ActionType;
  targetId: string;
  payload: Record<string, unknown>;
}

/**
 * Run a write inside an audit-wrapping transaction. When the caller has a
 * correlation id, the write + action_log insert land atomically; otherwise
 * it's just the write. The write closure can return an AuditRecord (logged)
 * or null (no audit row this call — used when an update was a no-op).
 */
function writeWithAudit(
  db: Database.Database,
  ctx: AgentExecutionContext | undefined,
  write: () => AuditRecord | null,
): void {
  if (!ctx?.correlationId) { write(); return; }
  const op = db.transaction(() => {
    const audit = write();
    if (!audit) return;
    appendAction(db, {
      correlation_id: ctx.correlationId!,
      command: ctx.command ?? "record",
      user_input: ctx.userInput ?? null,
      action_type: audit.actionType,
      target_id: audit.targetId,
      payload: audit.payload,
    });
  });
  op();
}

function buildTransactionInput(
  input: any,
  ctx: AgentExecutionContext,
): import("../../db/queries/transactions.js").TransactionInput {
  return {
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
}

async function accountExecute(
  db: Database.Database,
  name: string,
  input: any,
  ctx: AgentExecutionContext | undefined,
): Promise<string | undefined> {
  switch (name) {
    case "create_account": {
      if (!ACCOUNT_TYPES.includes(input.type)) {
        return `Invalid type "${input.type}". Allowed: ${ACCOUNT_TYPES.join(", ")}.`;
      }
      return await runAccountExclusive(() => {
        try {
          writeWithAudit(db, ctx, () => {
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
            return {
              actionType: "create_account",
              targetId: input.id,
              payload: { row: findAccountById(db, input.id) },
            };
          });
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
      return await runAccountExclusive(() => {
        try {
          let changed = false;
          writeWithAudit(db, ctx, () => {
            const result = updateAccountMetadata(db, input.account_id, {
              due_day: input.due_day,
              statement_day: input.statement_day,
              points_balance: input.points_balance,
              account_number_masked: input.account_number_masked,
              bank_name: input.bank_name,
              metadata: input.metadata,
            });
            changed = result.changed;
            if (!result.changed) return null;
            return {
              actionType: "update_account_metadata",
              targetId: input.account_id,
              payload: { before: result.before, after: result.after },
            };
          });
          return changed ? `Updated ${input.account_id}.` : "Nothing to update.";
        } catch (err: any) {
          if (String(err.message).includes("not found")) {
            return `Account "${input.account_id}" not found.`;
          }
          throw err;
        }
      });
    }

    case "record_transactions": {
      if (!ctx) return "record_transactions is only available inside an agent session.";
      if (!ctx.buffer) return "record_transactions is only available during a scan (no buffer in this context).";
      const items: any[] = Array.isArray(input?.transactions) ? input.transactions : [];
      if (items.length === 0) return "record_transactions requires at least one transaction.";
      if (items.length > BATCH_MAX) {
        return `record_transactions accepts at most ${BATCH_MAX} transactions per call; got ${items.length}. Split into smaller batches.`;
      }

      const posted: { index: number; transactionId: string; date: string }[] = [];
      const failed: { index: number; error: string }[] = [];

      const chunkId = ctx.chunkId ?? "unattributed";
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        try {
          const txInput = buildTransactionInput(item, ctx);
          validateTransaction(txInput);
          const transactionId = await ctx.buffer.appendTransaction(txInput, chunkId);
          posted.push({ index: i, transactionId, date: item.date });
        } catch (err: any) {
          failed.push({ index: i, error: err?.message ?? "unknown error" });
        }
      }

      const lines: string[] = [`Posted ${posted.length} of ${items.length}.`];
      if (posted.length > 0) {
        lines.push(...posted.map(p => `- index ${p.index}: ${p.transactionId} (${p.date})`));
      }
      if (failed.length > 0) {
        lines.push("Failed:");
        lines.push(...failed.map(f => `- index ${f.index}: ${f.error}`));
        lines.push("Retry the failed indices with corrections.");
      }
      return lines.join("\n");
    }

    case "record_transaction": {
      if (!ctx) return "record_transaction is only available inside an agent session.";
      const txInput = buildTransactionInput(input, ctx);
      try {
        if (ctx.buffer) {
          validateTransaction(txInput);
          const transactionId = await ctx.buffer.appendTransaction(txInput, ctx.chunkId ?? "unattributed");
          return `Posted transaction ${transactionId} (${input.date}).`;
        }
        // No-audit path uses recordTransaction (validates + inserts in one go).
        // Audit path validates ahead so the validated id can be returned without
        // re-reading from disk after the transaction commits.
        if (!ctx.correlationId) {
          const transactionId = recordTransaction(db, txInput);
          return `Posted transaction ${transactionId} (${input.date}).`;
        }
        const validated = validateTransaction(txInput);
        writeWithAudit(db, ctx, () => {
          insertTransactionRows(db, validated);
          return {
            actionType: "record_transaction",
            targetId: validated.id,
            payload: {
              transaction: {
                date: validated.date,
                description: validated.description,
                source_page: validated.source_page ?? null,
                raw_descriptor: validated.raw_descriptor ?? null,
              },
              postings: validated.postings,
            },
          };
        });
        return `Posted transaction ${validated.id} (${input.date}).`;
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
 * Scan-only unknowns
 *
 * `note_unknown` records a clarification mid-scan without ever prompting the
 * user — only scan needs this. Record uses `clarify` (transient prompt, no
 * unknowns-table residue); resolve uses `ask_user` (prompts and resolves).
 */

const UNKNOWN_DEFS: ToolDefinition[] = [
  {
    name: "note_unknown",
    description:
      "Record a clarification request without pausing the run. Use during scan when a row is ambiguous (post your best-guess transaction first, then call this with the transaction's id), when a row is unparseable (skip the transaction, call this with no transaction_id), or when you have a unknown about an account itself (pass account_id). Use kind='uncategorized_expense' when posting an expense to expense:uncategorized so resolve can group these. The resolver picks these up later with the full picture.",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "The question or unknown in a complete sentence, with date, ฿-formatted amount, and human account names. Never reference internal ids.",
        },
        kind: {
          type: "string",
          description:
            "Optional category for the unknown. Use 'uncategorized_expense' when the posting landed in expense:uncategorized; the resolver batches these into one cleanup pass.",
        },
        options: {
          type: "array",
          description:
            "Optional list of candidate answers the resolver can offer the user.",
          items: { type: "string" },
        },
        transaction_id: {
          type: "string",
          description:
            "Id of the transaction this unknown relates to (returned by record_transaction). Omit for file-level unknowns about an unparseable row.",
        },
        account_id: {
          type: "string",
          description:
            "Id of the account this unknown relates to. Set when the statement's bank name, currency, statement_day, due_day, or other metadata disagrees with the stored account, or when you suspect a new account you're about to create duplicates an existing one. Can be combined with transaction_id.",
        },
      },
      required: ["prompt"],
    },
  },
];

const UNKNOWN_LABELS: Record<string, string> = {
  note_unknown: "Noting unknown",
};

async function unknownExecute(
  db: Database.Database,
  name: string,
  input: any,
  ctx: AgentExecutionContext | undefined,
): Promise<string | undefined> {
  if (name !== "note_unknown") return undefined;
  if (!ctx) return "note_unknown is only available inside an agent session.";
  const transaction_id = input.transaction_id ?? null;
  const account_id = input.account_id ?? null;
  if (ctx.buffer) {
    await ctx.buffer.appendUnknown({
      chunkId: ctx.chunkId ?? null,
      transaction_id,
      account_id,
      kind: input.kind ?? null,
      prompt: input.prompt,
      options: input.options,
    });
    return `Unknown noted (buffered). Continue with the next row.`;
  }
  const id = recordUnknown(db, {
    file_id: ctx.fileId ?? null,
    transaction_id,
    account_id,
    kind: input.kind ?? null,
    prompt: input.prompt,
    options: input.options,
  });
  return `Unknown noted (${id}). Continue with the next row.`;
}

export const scanUnknownTools: ToolModule = {
  DEFS: UNKNOWN_DEFS,
  LABELS: UNKNOWN_LABELS,
  execute: unknownExecute,
};
