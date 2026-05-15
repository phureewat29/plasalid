import type Database from "libsql";
import { findAccountById } from "../../db/queries/account_balance.js";
import { recordJournalEntry } from "../../db/queries/journal.js";
import {
  getConcernTarget,
  recordConcern,
  resolveConcern,
} from "../../db/queries/concerns.js";
import { runExclusive as runAccountExclusive } from "../../scanner/account_mutex.js";
import { sanitizeForPrompt } from "../sanitize.js";
import {
  ALL_THAI_INSTITUTIONS,
  ACCOUNT_TYPE_DESCRIPTIONS,
} from "../../accounts/taxonomy.js";
import type { AgentExecutionContext, ToolDefinition, ToolModule } from "./types.js";

const ACCOUNT_TYPES = Object.keys(ACCOUNT_TYPE_DESCRIPTIONS);

// ── Scan-side tool definitions ──────────────────────────────────────────────
// These tools are exposed during both `plasalid scan` and `plasalid review`:
// scan uses them to post the initial picture; review uses the same primitives
// to fix mistakes (re-create a botched account, post a corrected entry, etc.).
// `note_concern` belongs here too — it records a clarification without ever
// prompting the user, which is what scan needs.

const SCAN_DEFS: ToolDefinition[] = [
  {
    name: "create_account",
    description:
      "Create a new account in the chart of accounts when a statement reveals one that doesn't exist yet. Use a stable id like 'asset:kbank-savings-1234'.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Stable identifier, lowercase, colon-separated. e.g. 'asset:kbank-savings-1234'." },
        name: { type: "string", description: "Human-readable name. e.g. 'KBank Savings ••1234'." },
        type: { type: "string", enum: ACCOUNT_TYPES, description: "Account type." },
        subtype: { type: "string", description: "e.g. 'bank', 'credit_card', 'salary', 'food'." },
        bank_name: { type: "string", description: "Thai institution code from the taxonomy (e.g. KBANK, SCB, KTC)." },
        account_number_masked: { type: "string", description: "Last 4 digits only, e.g. '••1234'." },
        currency: { type: "string", description: "ISO 4217 code. Defaults to 'THB'.", default: "THB" },
        due_day: { type: "number", description: "Credit-card due day of month (liabilities only)." },
        statement_day: { type: "number", description: "Statement-cut day of month." },
        metadata: { type: "object", description: "Free-form extra fields (e.g. {points_program: 'KTC Forever'})." },
      },
      required: ["id", "name", "type"],
    },
  },
  {
    name: "update_account_metadata",
    description: "Update account metadata (due day, statement day, points balance, masked number, bank).",
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
    name: "record_journal_entry",
    description:
      "Post a balanced double-entry journal entry. The sum of debits MUST equal the sum of credits (within one currency). Convert Buddhist-Era dates by subtracting 543. Every line carries an ISO 4217 currency code (THB, USD, EUR, …); default to THB. Use the account's currency where set; only deviate when the source row is explicitly in another currency.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "ISO Gregorian date (YYYY-MM-DD)." },
        description: { type: "string", description: "Short human-readable description of the entry." },
        source_page: { type: "number", description: "Page number in the source PDF, if known." },
        lines: {
          type: "array",
          description: "Two or more journal lines that balance.",
          items: {
            type: "object",
            properties: {
              account_id: { type: "string", description: "Existing account id from list_accounts or create_account." },
              debit: { type: "number", description: "Debit amount in this line's currency. Use 0 if this line is a credit." },
              credit: { type: "number", description: "Credit amount in this line's currency. Use 0 if this line is a debit." },
              currency: { type: "string", description: "ISO 4217 currency code for this line (e.g. THB, USD, EUR). Defaults to THB.", default: "THB" },
              memo: { type: "string", description: "Optional per-line memo." },
            },
            required: ["account_id"],
          },
        },
      },
      required: ["date", "description", "lines"],
    },
  },
  {
    name: "note_concern",
    description:
      "Record a clarification request without pausing the run. Use during scan when a row is ambiguous (post your best-guess journal entry first, then call this with the entry's id), when a row is unparseable (skip the entry, call this with no entry_id), or when you have a concern about an account itself (pass account_id). The reviewer picks these up later with the full picture.",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The question or concern in a complete sentence, with date, ฿-formatted amount, and human account names. Never reference internal ids.",
        },
        options: {
          type: "array",
          description: "Optional list of candidate answers the reviewer can offer the user.",
          items: { type: "string" },
        },
        entry_id: {
          type: "string",
          description: "Id of the journal entry this concern relates to (returned by record_journal_entry). Omit for file-level concerns about an unparseable row.",
        },
        account_id: {
          type: "string",
          description: "Id of the account this concern relates to. Set when the statement's bank name, currency, statement_day, due_day, or other metadata disagrees with the stored account, or when you suspect a new account you're about to create duplicates an existing one. Can be combined with entry_id.",
        },
      },
      required: ["prompt"],
    },
  },
];

const SCAN_LABELS: Record<string, string> = {
  create_account: "Creating account",
  update_account_metadata: "Updating account metadata",
  record_journal_entry: "Posting journal entry",
  note_concern: "Noting concern",
};

async function scanExecute(
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
      const bank = input.bank_name ? String(input.bank_name).toUpperCase() : null;
      // Account writes serialize across concurrent scan agents so the next
      // list_accounts call (from any agent) sees this row.
      return await runAccountExclusive(() => {
        try {
          db.prepare(
            `INSERT INTO accounts (id, name, type, subtype, bank_name, account_number_masked, currency, due_day, statement_day, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            input.id,
            input.name,
            input.type,
            input.subtype || null,
            bank,
            input.account_number_masked || null,
            input.currency || "THB",
            input.due_day ?? null,
            input.statement_day ?? null,
            input.metadata ? JSON.stringify(input.metadata) : null,
          );
          return `Account created: ${input.id} (${input.name}, ${input.type}).`;
        } catch (err: any) {
          if (String(err.message).includes("UNIQUE")) {
            return `Account "${input.id}" already exists. Use update_account_metadata to modify it.`;
          }
          throw err;
        }
      });
    }

    case "update_account_metadata": {
      if (ctx?.dryRun) return `Would update metadata for ${input.account_id}: ${JSON.stringify(input)}`;
      return await runAccountExclusive(() => {
        const acct = findAccountById(db, input.account_id);
        if (!acct) return `Account "${input.account_id}" not found.`;
        const updates: string[] = [];
        const params: any[] = [];
        if (input.due_day !== undefined) { updates.push("due_day = ?"); params.push(input.due_day); }
        if (input.statement_day !== undefined) { updates.push("statement_day = ?"); params.push(input.statement_day); }
        if (input.points_balance !== undefined) { updates.push("points_balance = ?"); params.push(input.points_balance); }
        if (input.account_number_masked !== undefined) { updates.push("account_number_masked = ?"); params.push(input.account_number_masked); }
        if (input.bank_name !== undefined) { updates.push("bank_name = ?"); params.push(String(input.bank_name).toUpperCase()); }
        if (input.metadata) {
          const existing = acct.metadata_json ? JSON.parse(acct.metadata_json) : {};
          const merged = { ...existing, ...input.metadata };
          updates.push("metadata_json = ?");
          params.push(JSON.stringify(merged));
        }
        if (updates.length === 0) return "Nothing to update.";
        params.push(input.account_id);
        db.prepare(`UPDATE accounts SET ${updates.join(", ")} WHERE id = ?`).run(...params);
        return `Updated ${input.account_id}.`;
      });
    }

    case "record_journal_entry": {
      if (!ctx) return "record_journal_entry is only available inside an agent session.";
      if (ctx.dryRun) return `Would post journal entry "${input.description}" on ${input.date}.`;
      const entryInput = {
        date: input.date,
        description: input.description,
        source_file_id: ctx.fileId,
        source_page: input.source_page ?? null,
        lines: (input.lines || []).map((l: any) => ({
          account_id: l.account_id,
          debit: l.debit ?? 0,
          credit: l.credit ?? 0,
          currency: l.currency || "THB",
          memo: l.memo ?? null,
        })),
      };
      try {
        const entryId = ctx.buffer
          ? ctx.buffer.appendEntry(entryInput)
          : recordJournalEntry(db, entryInput);
        return `Posted journal entry ${entryId} (${input.date}).`;
      } catch (err: any) {
        return `Could not post journal entry: ${err.message}`;
      }
    }

    case "note_concern": {
      if (!ctx) return "note_concern is only available inside an agent session.";
      const target = {
        entry_id: input.entry_id ?? null,
        account_id: input.account_id ?? null,
      };
      if (ctx.buffer) {
        ctx.buffer.appendConcern({ ...target, prompt: input.prompt, options: input.options });
        return `Concern noted (buffered). Continue with the next row.`;
      }
      const id = recordConcern(db, {
        file_id: ctx.fileId ?? null,
        entry_id: target.entry_id,
        account_id: target.account_id,
        prompt: input.prompt,
        options: input.options,
      });
      return `Concern noted (${id}). Continue with the next row.`;
    }

    default:
      return undefined;
  }
}

export const scanIngestTools: ToolModule = {
  DEFS: SCAN_DEFS,
  LABELS: SCAN_LABELS,
  execute: scanExecute,
};

// ── Review-only tool definitions ────────────────────────────────────────────
// `ask_user` is the only interactive primitive. Scan never reaches it (the
// scan profile doesn't include this module), so we don't need a "scan, please
// don't use this" guard.

const REVIEW_DEFS: ToolDefinition[] = [
  {
    name: "ask_user",
    description:
      "Ask the user a clarifying question when you cannot confidently proceed. The pipeline pauses and prompts the user interactively. Available during `plasalid review`. Not exposed during `plasalid scan` — use `note_concern` instead. Pass `entry_id` / `account_id` to attach the question to the same target as a scan-noted concern. Pass `concern_id` to resolve an existing open concern in place (recommended when re-posing a scan-noted concern to the user). Pass `related_concern_ids` to apply the user's single answer to a whole group of sibling concerns at once.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The question to ask in plain language." },
        options: {
          type: "array",
          description: "Optional list of candidate answers.",
          items: { type: "string" },
        },
        entry_id: {
          type: "string",
          description: "Optional: journal entry this question is about. Used to clear the entry's has_concern flag once all its concerns close.",
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

  // Two modes: resolve an existing concern in place (concern_id supplied),
  // or post a fresh question that becomes its own concerns row.
  let id: string;
  if (input.concern_id) {
    id = String(input.concern_id);
    if (!getConcernTarget(db, id)) return `Concern ${id} not found.`;
  } else {
    id = recordConcern(db, {
      file_id: ctx.fileId ?? null,
      entry_id: input.entry_id ?? null,
      account_id: input.account_id ?? null,
      prompt: input.prompt,
      options: input.options,
    });
  }

  if (ctx.interactive && ctx.promptUser) {
    const answer = await ctx.promptUser(input.prompt, input.options, input.facts);
    resolveConcern(db, id, answer);
    // Propagate the same answer to every sibling in the group so the user
    // isn't asked the same thing again. Skip the primary id if the agent
    // happened to include it.
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
