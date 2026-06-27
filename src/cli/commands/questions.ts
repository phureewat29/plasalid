import type { Command } from "commander";
import type { QuestionRow } from "../../db/queries/questions.js";
import { emitList, fail, runAction, type Column } from "../output.js";

interface QuestionListRow {
  id: string;
  kind: string | null;
  prompt: string;
  transfer_id: string | null;
  account_id: string | null;
  options: unknown;
  context: unknown;
  file_id: string | null;
  created_at: string;
}

function parseJsonColumn(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toListRow(row: QuestionRow): QuestionListRow {
  return {
    id: row.id,
    kind: row.kind,
    prompt: row.prompt,
    transfer_id: row.transfer_id,
    account_id: row.account_id,
    options: parseJsonColumn(row.options_json),
    context: parseJsonColumn(row.context_json),
    file_id: row.file_id,
    created_at: row.created_at,
  };
}

// The question `prompt` is the free-text field. options/context are structured
// JSON that can embed account/transaction ids the agent needs verbatim (and
// bare-string option arrays with no key to allowlist), so they are left intact.
const QUESTION_REDACT_FIELDS = ["prompt"] as const;

const LIST_COLUMNS: Column<QuestionListRow>[] = [
  { header: "id", value: (r) => r.id },
  { header: "kind", value: (r) => r.kind ?? "" },
  { header: "prompt", value: (r) => r.prompt },
  { header: "transfer_id", value: (r) => r.transfer_id ?? "" },
  { header: "account_id", value: (r) => r.account_id ?? "" },
  { header: "options", value: (r) => (r.options != null ? JSON.stringify(r.options) : "") },
  { header: "context", value: (r) => (r.context != null ? JSON.stringify(r.context) : "") },
  { header: "file_id", value: (r) => r.file_id ?? "" },
  { header: "created_at", value: (r) => r.created_at },
];

interface AnsweredRow {
  id: string;
  kind: string | null;
  answer: string;
  rule_key: string | null;
}

const ANSWERED_COLUMNS: Column<AnsweredRow>[] = [
  { header: "id", value: (r) => r.id },
  { header: "kind", value: (r) => r.kind ?? "" },
  { header: "answer", value: (r) => r.answer },
  { header: "rule_key", value: (r) => r.rule_key ?? "" },
];

export function registerQuestions(program: Command): void {
  const questions = program.command("questions").description("Manage open questions");

  questions
    .command("list")
    .description("List questions")
    .option("--kind <kind>", "filter by question kind")
    .option("--file <id>", "filter by file id")
    .option("--batch <id>", "filter by batch id")
    .option("--include-deferred", "include deferred questions")
    .option("--limit <n>", "maximum number of results")
    .option("--redact", "mask PII in the question prompt")
    .action(
      runAction(async (opts: any) => {
        let limit: number | undefined;
        if (opts.limit !== undefined) {
          limit = Number(opts.limit);
          if (!Number.isFinite(limit) || limit <= 0) {
            fail("USAGE", `--limit must be a positive number, got "${opts.limit}"`);
          }
        }
        const { getDb } = await import("../../db/connection.js");
        const { listQuestions } = await import("../../db/queries/questions.js");
        const db = getDb();
        const rows = listQuestions(db, {
          kind: opts.kind,
          fileId: opts.file,
          scanId: opts.batch,
          includeDeferred: !!opts.includeDeferred,
          limit,
        });
        let listRows = rows.map(toListRow);
        if (opts.redact) {
          const { applyRedaction } = await import("../../privacy/redactor.js");
          listRows = applyRedaction(listRows, true, QUESTION_REDACT_FIELDS);
        }
        emitList(listRows, LIST_COLUMNS);
      }),
    );

  questions
    .command("answer <id>")
    .description("Answer a question")
    .option("--answer <text>", "the answer text")
    .option("--also <ids>", "additional question ids to answer")
    .action(
      runAction(async (id: string, opts: any) => {
        if (!opts.answer) fail("USAGE", "--answer is required");
        const also: string[] = opts.also
          ? String(opts.also)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
        const ids = [id, ...also];

        const { getDb } = await import("../../db/connection.js");
        const { closeQuestion } = await import("../../db/queries/questions.js");
        const db = getDb();

        const results: AnsweredRow[] = [];
        for (const qid of ids) {
          const closed = closeQuestion(db, qid, opts.answer);
          if (!closed) fail("NOT_FOUND", `question "${qid}" not found`);
          results.push({ id: qid, kind: closed.kind, answer: closed.answer, rule_key: closed.rule_key });
        }
        emitList(results, ANSWERED_COLUMNS);
      }),
    );

  questions
    .command("defer <id>")
    .description("Defer a question")
    .option("--days <n>", "number of days to defer")
    .action(
      runAction(async (id: string, opts: any) => {
        let days = 7;
        if (opts.days !== undefined) {
          days = Number(opts.days);
          if (!Number.isFinite(days)) fail("USAGE", `--days must be a number, got "${opts.days}"`);
        }
        const { getDb } = await import("../../db/connection.js");
        const { deferQuestion } = await import("../../db/queries/questions.js");
        const db = getDb();
        const ok = deferQuestion(db, id, days);
        if (!ok) fail("NOT_FOUND", `question "${id}" not found`);
        emitList([{ id, days }], [
          { header: "id", value: (r: { id: string; days: number }) => r.id },
          { header: "days", value: (r: { id: string; days: number }) => String(r.days) },
        ]);
      }),
    );
}
