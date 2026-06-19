import type { Command } from "commander";
import { getDb } from "../../db/connection.js";
import { currentMode, emit, emitList, fail, runAction, type Column } from "../output.js";
import {
  listPostings,
  groupByTransaction,
  updatePosting,
  type ListPostingsOptions,
  type PostingRow,
  type TransactionGroup,
  type UpdatePostingFields,
} from "../../db/queries/transactions.js";
import { searchPostings } from "../../db/queries/search.js";
import { applyRedaction } from "../../privacy/redactor.js";

// Free-text fields on a PostingRow that may carry PII. account_id/currency and
// the numeric amount fields are structured data the agent needs verbatim and
// are deliberately excluded.
const POSTING_REDACT_FIELDS = [
  "transaction_description",
  "memo",
  "merchant_name",
  "account_name",
] as const;

const POSTING_COLUMNS: Column<PostingRow>[] = [
  { header: "ID", value: (p) => p.id },
  { header: "Date", value: (p) => p.transaction_date ?? "" },
  { header: "Description", value: (p) => p.transaction_description ?? "" },
  { header: "Account", value: (p) => p.account_name ?? p.account_id },
  { header: "Debit", value: (p) => (p.debit ? p.debit.toFixed(2) : ""), align: "right" },
  { header: "Credit", value: (p) => (p.credit ? p.credit.toFixed(2) : ""), align: "right" },
  { header: "Currency", value: (p) => p.currency },
  { header: "Memo", value: (p) => p.memo ?? "" },
];

function parseOptionalNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) fail("USAGE", `${flag} must be a number, got "${value}"`);
  return n;
}

function emitGroupedPostings(groups: TransactionGroup[]): void {
  const mode = currentMode();
  if (mode.json) {
    emit(groups);
    return;
  }
  if (mode.tty) {
    renderGroupsTty(groups);
    return;
  }
  renderGroupsPlain(groups);
}

function renderGroupsTty(groups: TransactionGroup[]): void {
  for (const g of groups) {
    const merchant = g.merchant ? `  (${g.merchant})` : "";
    process.stdout.write(`${g.date}  ${g.description}${merchant}\n`);
    for (const p of g.postings) {
      const amount = p.debit ? `-${p.debit.toFixed(2)}` : `+${p.credit.toFixed(2)}`;
      const memo = p.memo ? `  ${p.memo}` : "";
      process.stdout.write(`  ${p.account_name ?? p.account_id}  ${amount} ${p.currency}${memo}\n`);
    }
    process.stdout.write("\n");
  }
}

function renderGroupsPlain(groups: TransactionGroup[]): void {
  const lines: string[] = [];
  for (const g of groups) {
    lines.push(["T", g.transaction_id, g.date, g.description, g.merchant ?? ""].join("\t"));
    for (const p of g.postings) {
      lines.push(
        ["P", p.id, p.account_id, String(p.debit), String(p.credit), p.currency, p.memo ?? ""].join(
          "\t",
        ),
      );
    }
  }
  if (lines.length) process.stdout.write(lines.join("\n") + "\n");
}

export function registerPostings(program: Command): void {
  const postings = program.command("postings").description("Manage ledger postings");

  postings
    .command("list")
    .description("List postings")
    .option("--account <id>", "filter by account id")
    .option("--from <date>", "filter from date")
    .option("--to <date>", "filter to date")
    .option("--query <text>", "filter by search text")
    .option("--limit <n>", "maximum number of results")
    .option("--group", "group results by account")
    .option("--redact", "mask PII in free-text fields (descriptions, memos, merchant names)")
    .action(
      runAction(
        (opts: {
          account?: string;
          from?: string;
          to?: string;
          query?: string;
          limit?: string;
          group?: boolean;
          redact?: boolean;
        }) => {
          const db = getDb();
          const listOpts: ListPostingsOptions = {};
          if (opts.account) listOpts.account_id = opts.account;
          if (opts.from) listOpts.from = opts.from;
          if (opts.to) listOpts.to = opts.to;
          if (opts.query) listOpts.q = opts.query;
          const limit = parseOptionalNumber(opts.limit, "--limit");
          if (limit !== undefined) listOpts.limit = limit;

          const rows = applyRedaction(
            listPostings(db, listOpts),
            !!opts.redact,
            POSTING_REDACT_FIELDS,
          );
          if (opts.group) {
            emitGroupedPostings(groupByTransaction(rows));
            return;
          }
          emitList(rows, POSTING_COLUMNS);
        },
      ),
    );

  postings
    .command("search")
    .description("Search postings")
    .option("--query <text>", "search text")
    .option("--limit <n>", "maximum number of results")
    .option("--redact", "mask PII in free-text fields (descriptions, memos, merchant names)")
    .action(
      runAction((opts: { query?: string; limit?: string; redact?: boolean }) => {
        if (!opts.query) fail("USAGE", "--query is required");
        const db = getDb();
        const limit = parseOptionalNumber(opts.limit, "--limit");
        const rows = applyRedaction(
          searchPostings(db, opts.query, limit),
          !!opts.redact,
          POSTING_REDACT_FIELDS,
        );
        emitList(rows, POSTING_COLUMNS);
      }),
    );

  postings
    .command("update <id>")
    .description("Update a posting")
    .option("--account <id>", "account id to set")
    .option("--memo <text>", "memo to set")
    .action(
      runAction((id: string, opts: { account?: string; memo?: string }) => {
        const db = getDb();
        const fields: UpdatePostingFields = {};
        if (opts.account !== undefined) fields.account_id = opts.account;
        if (opts.memo !== undefined) fields.memo = opts.memo;
        if (Object.keys(fields).length === 0) {
          fail("USAGE", "at least one of --account or --memo is required");
        }
        let changes: number;
        try {
          changes = updatePosting(db, id, fields);
        } catch (err) {
          fail("INVALID", (err as Error).message);
        }
        if (changes === 0) fail("NOT_FOUND", `posting "${id}" not found`);
        emit({ posting_id: id, updated: true });
      }),
    );
}
