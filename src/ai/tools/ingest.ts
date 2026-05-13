import type Database from "libsql";
import { randomUUID } from "crypto";
import { findAccountById } from "../../db/queries/account_balance.js";
import { recordJournalEntry } from "../../db/queries/journal.js";
import { sanitizeForPrompt } from "../sanitize.js";
import {
  ALL_THAI_INSTITUTIONS,
  ACCOUNT_TYPE_DESCRIPTIONS,
} from "../../accounts/taxonomy.js";
import type { AgentExecutionContext, ToolDefinition, ToolModule } from "./types.js";

const ACCOUNT_TYPES = Object.keys(ACCOUNT_TYPE_DESCRIPTIONS);

const DEFS: ToolDefinition[] = [
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
    name: "ask_user",
    description:
      "Ask the user a clarifying question when you cannot confidently proceed. The pipeline pauses and prompts the user interactively when running `plasalid scan` or `plasalid reconcile`.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The question to ask in plain language." },
        options: {
          type: "array",
          description: "Optional list of candidate answers.",
          items: { type: "string" },
        },
      },
      required: ["prompt"],
    },
  },
];

const LABELS: Record<string, string> = {
  create_account: "Creating account",
  update_account_metadata: "Updating account metadata",
  record_journal_entry: "Posting journal entry",
  ask_user: "Asking for clarification",
};

async function execute(
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
      const knownCodes = new Set(ALL_THAI_INSTITUTIONS.map(i => i.code));
      const bank = input.bank_name ? String(input.bank_name).toUpperCase() : null;
      if (bank && !knownCodes.has(bank)) {
        // Allow unknown institutions; taxonomy is a hint, not a hard list.
      }
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
    }

    case "update_account_metadata": {
      if (ctx?.dryRun) return `Would update metadata for ${input.account_id}: ${JSON.stringify(input)}`;
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
    }

    case "record_journal_entry": {
      if (!ctx) return "record_journal_entry is only available inside an agent session.";
      if (ctx.dryRun) return `Would post journal entry "${input.description}" on ${input.date}.`;
      try {
        const entryId = recordJournalEntry(db, {
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
        });
        return `Posted journal entry ${entryId} (${input.date}).`;
      } catch (err: any) {
        return `Could not post journal entry: ${err.message}`;
      }
    }

    case "ask_user": {
      if (!ctx) return "ask_user is only available inside an agent session.";
      const id = `pq:${randomUUID()}`;
      db.prepare(
        `INSERT INTO pending_questions (id, file_id, prompt, options_json) VALUES (?, ?, ?, ?)`,
      ).run(id, ctx.fileId ?? null, input.prompt, input.options ? JSON.stringify(input.options) : null);
      if (ctx.interactive && ctx.promptUser) {
        const answer = await ctx.promptUser(input.prompt, input.options);
        db.prepare(`UPDATE pending_questions SET answer = ?, resolved_at = datetime('now') WHERE id = ?`).run(answer, id);
        return `User answered: ${sanitizeForPrompt(answer)}`;
      }
      return `Question recorded for later (${id}). Awaiting user input — do not act on assumptions about this answer.`;
    }

    default:
      return undefined;
  }
}

export const ingestTools: ToolModule = { DEFS, LABELS, execute };
