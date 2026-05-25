import type Database from "libsql";
import {
  createAccount,
  updateAccountMetadata,
} from "../../db/queries/account-balance.js";
import {
  recordTransaction,
  type TransactionInput,
} from "../../db/queries/transactions.js";
import { runExclusive as runAccountExclusive } from "./account-mutex.js";
import { ACCOUNT_TYPE_DESCRIPTIONS } from "../../accounts/taxonomy.js";
import { recordQuestion } from "../../db/queries/questions.js";
import { commitTransaction } from "../../scanner/commit.js";
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
    description: `Post many balanced double-entry transactions in a single tool call. **Strongly preferred over record_transaction whenever you have more than one row to post** — the scan tool-step budget is finite (100 per file) and the singular form burns one step per row. Each item has the same shape as record_transaction. Validation runs per item: valid items are written directly to the DB and their ids returned; invalid items are reported back so you can fix and retry just those indices. Limit each call to ≤${BATCH_MAX} transactions; chunk larger statements across multiple calls.`,
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

function buildTransactionInput(
  input: any,
  ctx: AgentExecutionContext,
): TransactionInput {
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

/**
 * Thin adapter that wires the agent's execution context into the staged
 * commit pipeline. The pipeline does best-effort resolution (NULL unknown
 * merchant, fuzzy-match-or-create unknown account) and only drops a row on
 * genuine validation failure. Failures raise typed questions rather than
 * burning a "scan_commit_failure" memory rule.
 */
async function persistOneTransaction(
  db: Database.Database,
  ctx: AgentExecutionContext,
  txInput: TransactionInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const outcome = commitTransaction(
    db,
    {
      scanId: ctx.scanId ?? null,
      fileId: ctx.fileId ?? null,
      chunkId: ctx.chunkId ?? null,
      progress: ctx.progress ?? null,
    },
    txInput,
  );
  if (outcome.ok) return { ok: true, id: outcome.transactionId };
  return { ok: false, error: outcome.message };
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
          const result = updateAccountMetadata(db, input.account_id, {
            due_day: input.due_day,
            statement_day: input.statement_day,
            points_balance: input.points_balance,
            account_number_masked: input.account_number_masked,
            bank_name: input.bank_name,
            metadata: input.metadata,
          });
          return result.changed ? `Updated ${input.account_id}.` : "Nothing to update.";
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
      const items: any[] = Array.isArray(input?.transactions) ? input.transactions : [];
      if (items.length === 0) return "record_transactions requires at least one transaction.";
      if (items.length > BATCH_MAX) {
        return `record_transactions accepts at most ${BATCH_MAX} transactions per call; got ${items.length}. Split into smaller batches.`;
      }

      const posted: { index: number; transactionId: string; date: string }[] = [];
      const failed: { index: number; error: string }[] = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const txInput = buildTransactionInput(item, ctx);
        const outcome = await persistOneTransaction(db, ctx, txInput);
        if (outcome.ok) {
          posted.push({ index: i, transactionId: outcome.id, date: item.date });
        } else {
          failed.push({ index: i, error: outcome.error });
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
      if (ctx.scanId) {
        const outcome = await persistOneTransaction(db, ctx, txInput);
        return outcome.ok
          ? `Posted transaction ${outcome.id} (${input.date}).`
          : `Could not post transaction: ${outcome.error}`;
      }
      try {
        const transactionId = recordTransaction(db, txInput);
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

const QUESTION_DEFS: ToolDefinition[] = [
  {
    name: "note_question",
    description:
      "Record a clarification question without pausing the run. Use SPARINGLY during scan — best-guess expense categorization is preferred (small misses are cheap to fix; a flood of questions is not). Call note_question only when (a) the row is unparseable (skip the row, no transaction_id), (b) you have a doubt about an account itself (pass account_id), or (c) the amount/sign/date/counter-party is genuinely unclear (post your best-guess transaction first, then call this with the transaction_id). Use kind='uncategorized_expense' only for genuinely opaque expense descriptors that landed in expense:uncategorized. The clarifier picks these up later with the full picture.",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "The question in a complete sentence, with date, ฿-formatted amount, and human account names. Never reference internal ids.",
        },
        kind: {
          type: "string",
          description:
            "Optional category for the question. Use 'uncategorized_expense' when the posting landed in expense:uncategorized; the clarifier batches these into one cleanup pass.",
        },
        options: {
          type: "array",
          description:
            "Optional list of candidate answers the clarifier can offer the user.",
          items: { type: "string" },
        },
        transaction_id: {
          type: "string",
          description:
            "Id of the transaction this question relates to (returned by record_transaction). Omit for file-level questions about an unparseable row.",
        },
        account_id: {
          type: "string",
          description:
            "Id of the account this question relates to. Set when the statement's bank name, currency, statement_day, due_day, or other metadata disagrees with the stored account, or when you suspect a new account you're about to create duplicates an existing one. Can be combined with transaction_id.",
        },
      },
      required: ["prompt"],
    },
  },
];

const QUESTION_LABELS: Record<string, string> = {
  note_question: "Noting question",
};

async function questionExecute(
  db: Database.Database,
  name: string,
  input: any,
  ctx: AgentExecutionContext | undefined,
): Promise<string | undefined> {
  if (name !== "note_question") return undefined;
  if (!ctx) return "note_question is only available inside an agent session.";
  const id = recordQuestion(db, {
    file_id: ctx.fileId ?? null,
    scan_id: ctx.scanId ?? null,
    transaction_id: input.transaction_id ?? null,
    account_id: input.account_id ?? null,
    kind: input.kind ?? null,
    prompt: input.prompt,
    options: input.options,
  });
  if (ctx.progress && ctx.chunkId) {
    ctx.progress.emit({ chunkId: ctx.chunkId, kind: "question" });
  }
  return `Question noted (${id}). Continue with the next row.`;
}

export const scanQuestionTools: ToolModule = {
  DEFS: QUESTION_DEFS,
  LABELS: QUESTION_LABELS,
  execute: questionExecute,
};

const RESOLVE_DEFS: ToolDefinition[] = [
  {
    name: "ask_user",
    description:
      "Ask the user a clarifying question when you cannot confidently proceed. The pipeline pauses and prompts the user interactively. Available during `plasalid clarify`. Not exposed during `plasalid scan` — use `note_question` instead. Pass `question_id` to close an existing question in place. Pass `related_question_ids` to apply the user's single answer to a whole group of sibling questions at once.",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The question to ask in plain language.",
        },
        options: {
          type: "array",
          description: "Optional list of candidate answers.",
          items: { type: "string" },
        },
        question_id: {
          type: "string",
          description:
            "Id of the primary question this clarifies. The user's answer closes (deletes) that row.",
        },
        related_question_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: ids of additional questions that share the same answer as `question_id`. The user is prompted once; every listed question (plus the primary) is closed with the same answer.",
        },
        facts: {
          type: "object",
          description:
            "Optional structured highlights rendered as a single colored header line above the question.",
          properties: {
            amount: { type: "string" },
            date: { type: "string" },
            merchant: { type: "string" },
            accounts: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
      required: ["prompt", "question_id"],
    },
  },
  {
    name: "close_question",
    description:
      "Close an question by writing its answer and deleting the row WITHOUT prompting the user. Use after applying a mutation that a memory rule or heuristic already implied. Pass `related_question_ids` to close a sibling group in one call.",
    input_schema: {
      type: "object",
      properties: {
        question_id: { type: "string" },
        answer: {
          type: "string",
          description: "The implied answer to record.",
        },
        related_question_ids: { type: "array", items: { type: "string" } },
      },
      required: ["question_id", "answer"],
    },
  },
  {
    name: "defer_question",
    description:
      "Defer a question for `days` days. The row stays in the questions table but is hidden from `plasalid clarify` until the timestamp passes — the next run won't re-encounter it. Use when you genuinely lack info today and a future scan, a future conversation, or the user's own memory might surface the answer later. Prefer this over `close_question(answer=\"Skip — leave as is\")` whenever the question is still worth answering eventually.",
    input_schema: {
      type: "object",
      properties: {
        question_id: { type: "string" },
        days: {
          type: "number",
          description:
            "Days to defer. Default 7. Use shorter (1-2) when the user said 'ask me tomorrow' or 'let me check'; longer (30+) for genuinely seasonal data like annual statements.",
          default: 7,
        },
      },
      required: ["question_id"],
    },
  },
];

const RESOLVE_LABELS: Record<string, string> = {
  ask_user: "Asking for clarification",
  close_question: "Closing question",
  defer_question: "Deferring question",
};

async function clarifyIngestExecute(
  db: Database.Database,
  name: string,
  input: any,
  ctx: AgentExecutionContext | undefined,
): Promise<string | undefined> {
  if (name === "close_question") return closeQuestionTool(db, input, ctx);
  if (name === "defer_question") return deferQuestionTool(db, input);
  if (name !== "ask_user") return undefined;
  if (!ctx) return "ask_user is only available inside an agent session.";

  const primary = String(input.question_id ?? "");
  if (!primary) return "ask_user requires question_id.";

  if (ctx.interactive && ctx.promptUser) {
    const answer = await ctx.promptUser(input.prompt, input.options, input.facts);
    const { closeQuestion } = await import("../../db/queries/questions.js");
    const captured = closeQuestion(db, primary, answer);
    if (!captured) return `Question ${primary} not found.`;
    ctx.onQuestionClosed?.(captured);
    let propagated = 0;
    const siblings: string[] = Array.isArray(input.related_question_ids) ? input.related_question_ids : [];
    for (const sibId of siblings) {
      if (sibId === primary) continue;
      const sibClosed = closeQuestion(db, String(sibId), answer);
      if (sibClosed) {
        ctx.onQuestionClosed?.(sibClosed);
        propagated++;
      }
    }
    const total = 1 + propagated;
    return `User answered: ${answer}${total > 1 ? ` (applied to ${total} questions)` : ""}`;
  }
  return `Awaiting user input — cannot proceed in non-interactive mode.`;
}

async function deferQuestionTool(db: Database.Database, input: any): Promise<string> {
  const { deferQuestion } = await import("../../db/queries/questions.js");
  const id = String(input.question_id ?? "");
  if (!id) return "defer_question requires question_id.";
  const days = Number.isFinite(input.days) ? Math.max(1, Math.floor(input.days)) : 7;
  const updated = deferQuestion(db, id, days);
  return updated ? `Deferred question ${id} for ${days} day${days === 1 ? "" : "s"}.` : `Question ${id} not found.`;
}

async function closeQuestionTool(
  db: Database.Database,
  input: any,
  ctx: AgentExecutionContext | undefined,
): Promise<string> {
  const { closeQuestion } = await import("../../db/queries/questions.js");
  const primary = String(input.question_id ?? "");
  const answer = String(input.answer ?? "");
  if (!primary || !answer) return "close_question requires question_id and answer.";
  const captured = closeQuestion(db, primary, answer);
  if (!captured) return `Question ${primary} not found.`;
  ctx?.onQuestionClosed?.(captured);
  let count = 1;
  const siblings: string[] = Array.isArray(input.related_question_ids) ? input.related_question_ids : [];
  for (const sibId of siblings) {
    if (sibId === primary) continue;
    const sibClosed = closeQuestion(db, String(sibId), answer);
    if (sibClosed) {
      ctx?.onQuestionClosed?.(sibClosed);
      count++;
    }
  }
  return `Closed ${count} question${count === 1 ? "" : "s"}.`;
}

export const clarifyIngestTools: ToolModule = {
  DEFS: RESOLVE_DEFS,
  LABELS: RESOLVE_LABELS,
  execute: clarifyIngestExecute,
};
