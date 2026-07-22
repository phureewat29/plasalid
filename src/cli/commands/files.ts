import type { Command } from "commander";
import {
  type Column,
  currentMode,
  emit,
  emitList,
  fail,
  requireYes,
  runAction,
} from "../output.js";

/**
 * `files`: browse ingested files, inspect one with its transaction/question
 * counts, and drop one (cascade-removing its rows).
 */

/** JSON → one NDJSON object; human/plain → tab-separated key/value lines
 *  (ANSI-free, so it stays stable when piped). */
function emitObject(obj: Record<string, unknown>): void {
  if (currentMode().json) {
    emit(obj);
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    const s = v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
    process.stdout.write(`${k}\t${s}\n`);
  }
}

async function openDb() {
  const { getDb } = await import("../../db/connection.js");
  return getDb();
}

interface FilesListOpts {
  status?: string;
}

async function filesList(opts: FilesListOpts): Promise<void> {
  const db = await openDb();
  const { listFiles } = await import("../../db/queries/files.js");
  let rows = listFiles(db);
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);

  const columns: Column<(typeof rows)[number]>[] = [
    { header: "STATUS", value: (r) => r.status },
    { header: "ID", value: (r) => r.id },
    { header: "SOURCE", value: (r) => r.source ?? "-" },
    { header: "INGESTED_AT", value: (r) => r.ingested_at ?? "-" },
    { header: "PATH", value: (r) => r.path },
  ];
  emitList(rows, columns);
}

async function filesShow(id: string): Promise<void> {
  const db = await openDb();
  const { findFileById } = await import("../../db/queries/files.js");
  const row = findFileById(db, id);
  if (!row) fail("NOT_FOUND", `no file: ${id}`);

  const { countTransactionsBySourceFile } = await import("../../db/queries/transactions.js");
  const { countQuestions } = await import("../../db/queries/questions.js");
  emitObject({
    type: "file_detail",
    ...row,
    transaction_count: countTransactionsBySourceFile(db, id),
    open_question_count: countQuestions(db, { file_id: id }),
  });
}

interface FilesDropOpts {
  yes?: boolean;
}

async function filesDrop(id: string, opts: FilesDropOpts): Promise<void> {
  requireYes(opts, `dropping file ${id}`);
  const db = await openDb();
  const { deleteFile } = await import("../../db/queries/files.js");
  const res = deleteFile(db, id);
  if (!res.removed) fail("NOT_FOUND", `no file: ${id}`);
  emitObject({
    file_id: id,
    removed_transactions: res.removedTransactions,
    removed_questions: res.removedQuestions,
  });
}

export function registerFiles(program: Command): void {
  const files = program.command("files").description("Browse ingested files");

  files
    .command("list")
    .description("List ingested files")
    .option("--status <status>", "filter by status (new|pending|ingested|failed)")
    .action(runAction(filesList));

  files
    .command("show <id>")
    .description("Show a file with its transaction and open-question counts")
    .action(runAction(filesShow));

  files
    .command("drop <id>")
    .description("Drop a file and cascade-remove its transactions/questions")
    .option("--yes", "skip confirmation")
    .action(runAction(filesDrop));
}
