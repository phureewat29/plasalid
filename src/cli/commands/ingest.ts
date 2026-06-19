import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { resolve } from "path";
import type { Command } from "commander";
import type { CommitContext, CommitHooks } from "../../scanner/commit.js";
import type { TransactionInput } from "../../db/queries/transactions.js";
import {
  type Column,
  EXIT,
  currentMode,
  emit,
  emitItem,
  emitList,
  emitSummary,
  fail,
  readSecretFromStdin,
  readStdinTransactions,
  runAction,
} from "../output.js";

/**
 * `ingest` command tree for the deterministic harness.
 * Everything an external scan agent needs to drive the pipeline without the
 * interactive TUI: list candidate files, prepare pages, commit extracted rows,
 * and mark files done/failed. Heavy db/scanner imports are deferred inside each
 * action so non-db commands don't pay for libsql/mupdf at startup (mirrors the
 * pattern in status.ts).
 */

// --- small shared output helper -------------------------------------------

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

// --- pages spec parser (pure; unit-tested) ---------------------------------

/**
 * Parse a `--pages` spec into 0-based page indices for `prepareFile`.
 *   "all" / "" → undefined (every page)
 *   "1-5,8"    → [0,1,2,3,4,7]  (1-based input, converted to 0-based)
 * Malformed tokens raise CliError USAGE.
 */
export function parsePagesSpec(spec: string): number[] | undefined {
  const trimmed = spec.trim().toLowerCase();
  if (!trimmed || trimmed === "all") return undefined;

  const pages = new Set<number>();
  for (const rawTok of trimmed.split(",")) {
    const tok = rawTok.trim();
    if (!tok) continue;
    const m = tok.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) fail("USAGE", `invalid --pages token "${tok}" (expected N or N-M, 1-based)`);
    const start = parseInt(m[1], 10);
    const end = m[2] != null ? parseInt(m[2], 10) : start;
    if (start < 1) fail("USAGE", `--pages values are 1-based; "${tok}" is out of range`);
    if (end < start) fail("USAGE", `invalid --pages range "${tok}" (end before start)`);
    for (let p = start; p <= end; p++) pages.add(p - 1);
  }
  if (pages.size === 0) return undefined;
  return [...pages].sort((a, b) => a - b);
}

// --- ingest list -----------------------------------------------------------

interface ListOpts {
  regex?: string;
}

async function ingestList(opts: ListOpts): Promise<void> {
  const db = await openDb();
  const { discoverFiles } = await import("../../scanner/ingest.js");

  let regex: RegExp | undefined;
  if (opts.regex) {
    try {
      regex = new RegExp(opts.regex);
    } catch (err) {
      fail("USAGE", `invalid --regex: ${(err as Error).message}`);
    }
  }

  const entries = await discoverFiles(db, { regex });
  const counts = { new: 0, pending: 0, scanned: 0, failed: 0 };
  for (const e of entries) counts[e.status]++;
  const total = entries.length;

  const mode = currentMode();
  if (mode.json) {
    for (const e of entries) {
      emitItem({
        type: "file",
        path: e.path,
        rel_path: e.relPath,
        hash: e.hash,
        file_id: e.fileId,
        status: e.status,
        encrypted: e.encrypted,
        vault_candidates: e.vaultCandidates,
      });
    }
    emitSummary({ ...counts, total });
    return;
  }

  const columns: Column<(typeof entries)[number]>[] = [
    { header: "STATUS", value: (r) => r.status },
    { header: "ENC", value: (r) => (r.encrypted ? `yes(${r.vaultCandidates})` : "no") },
    { header: "FILE_ID", value: (r) => r.fileId ?? "-" },
    { header: "PATH", value: (r) => r.relPath },
  ];
  emitList(entries, columns);
  if (mode.tty) {
    process.stdout.write(
      `\n${counts.new} new, ${counts.pending} pending, ${counts.scanned} scanned, ${counts.failed} failed (${total} total)\n`,
    );
  }
}

// --- ingest prepare --------------------------------------------------------

interface PrepareOpts {
  passwordStdin?: boolean;
  force?: boolean;
  format?: string;
  dpi?: string;
  pages?: string;
  out?: string;
}

// Mirrors DEFAULT_DPI in scanner/pdf.ts (not exported), reported back so the
// caller knows the resolution used when rasterizing to png.
const DEFAULT_DPI = 150;

async function ingestPrepare(pathOrId: string, opts: PrepareOpts): Promise<void> {
  const db = await openDb();
  const { findScannedFileById } = await import("../../db/queries/files.js");

  const byId = findScannedFileById(db, pathOrId);
  if (!byId && !existsSync(resolve(pathOrId))) {
    fail("NOT_FOUND", `no ingest entry or file at "${pathOrId}"`);
  }

  if (opts.format && opts.format !== "png" && opts.format !== "pdf") {
    fail("USAGE", `--format must be "png" or "pdf" (got "${opts.format}")`);
  }
  const format = (opts.format ?? "png") as "png" | "pdf";

  const pages = parsePagesSpec(opts.pages ?? "all");

  let dpi: number | undefined;
  if (opts.dpi != null) {
    dpi = Number(opts.dpi);
    if (!Number.isFinite(dpi) || dpi <= 0) fail("USAGE", `--dpi must be a positive number (got "${opts.dpi}")`);
  }

  const password = opts.passwordStdin ? await readSecretFromStdin() : undefined;
  const outDir = opts.out ? resolve(opts.out) : undefined;

  const { prepareFile, PasswordRequiredError } = await import("../../scanner/ingest.js");
  let result;
  try {
    result = await prepareFile(db, pathOrId, {
      password,
      force: !!opts.force,
      format,
      dpi,
      pages,
      outDir,
    });
  } catch (err) {
    if (err instanceof PasswordRequiredError) {
      if (err.reason === "wrong_password") {
        fail("INPUT_REQUIRED", "incorrect password for encrypted PDF", {
          hint: "pipe the correct password with --password-stdin, or store one via `plasalid vault add <pattern> --password-stdin`",
        });
      }
      fail("INPUT_REQUIRED", "password required for encrypted PDF", {
        hint: "pipe the password with --password-stdin, or store one via `plasalid vault add <pattern> --password-stdin`",
      });
    }
    throw err;
  }

  emitObject({
    file_id: result.fileId,
    page_count: result.pageCount,
    format: result.format,
    dpi: result.format === "pdf" ? null : (dpi ?? DEFAULT_DPI),
    pages: result.pages,
  });
}

// --- ingest commit (the critical contract) ---------------------------------

interface CommitOpts {
  file?: string;
  scanId?: string;
}

type CommitEvent =
  | { kind: "placeholder"; accountId: string }
  | { kind: "fuzzy"; originalId: string; matchedId: string }
  | { kind: "unknown_merchant"; attemptedId: string }
  | { kind: "dirty"; reason: string };

/** Wrap the default hooks so every raised question still fires (delegated to
 *  the default), while we also capture a typed event per callback to build the
 *  per-posting resolution report afterwards. */
function makeRecordingHooks(base: CommitHooks, events: CommitEvent[]): CommitHooks {
  return {
    onCommitted: (txId) => base.onCommitted(txId),
    onDirtyInput: (input, reason) => {
      base.onDirtyInput(input, reason);
      events.push({ kind: "dirty", reason });
    },
    onUnknownMerchant: (input, txId, attemptedId) => {
      base.onUnknownMerchant(input, txId, attemptedId);
      events.push({ kind: "unknown_merchant", attemptedId });
    },
    onPlaceholderAccount: (accountId, txId) => {
      base.onPlaceholderAccount(accountId, txId);
      events.push({ kind: "placeholder", accountId });
    },
    onSimilarAccount: (originalId, matchedId, txId) => {
      base.onSimilarAccount(originalId, matchedId, txId);
      events.push({ kind: "fuzzy", originalId, matchedId });
    },
  };
}

function toTransactionInput(item: any, sourceFileId: string | null): TransactionInput {
  const postings = Array.isArray(item.postings) ? item.postings : [];
  return {
    date: item.date,
    description: item.description,
    source_file_id: sourceFileId,
    source_page: item.source_page ?? null,
    raw_descriptor: item.raw_descriptor ?? null,
    merchant: item.merchant ?? null,
    merchant_id: item.merchant_id ?? null,
    postings: postings.map((p: any) => ({
      account_id: p.account_id,
      debit: p.debit ?? 0,
      credit: p.credit ?? 0,
      currency: p.currency || "THB",
      memo: p.memo ?? null,
    })),
  };
}

type PostingHow = "exact" | "fuzzy_matched" | "placeholder_created" | "uncategorized_fallback";

/**
 * Classify how each *input* posting's account_id was resolved. Derived from the
 * captured hook events + a post-commit existence check — deliberately NOT from
 * getTransaction ordering (postings there are ORDER BY p.id, a random UUID, and
 * an extra equity:adjustments row may have been appended, so index alignment to
 * the input is unreliable).
 */
function classifyPosting(
  requested: string,
  events: CommitEvent[],
  accountExists: (id: string) => boolean,
): { resolved: string; how: PostingHow } {
  const fuzzy = events.find(
    (e): e is Extract<CommitEvent, { kind: "fuzzy" }> =>
      e.kind === "fuzzy" && e.originalId === requested,
  );
  if (fuzzy) return { resolved: fuzzy.matchedId, how: "fuzzy_matched" };

  const placeholder = events.find(
    (e) => e.kind === "placeholder" && e.accountId === requested,
  );
  if (placeholder) return { resolved: requested, how: "placeholder_created" };

  // No event keyed to `requested`: it was either resolved exactly (account
  // exists) or redirected to expense:uncategorized (invalid/unresolvable path).
  if (accountExists(requested)) return { resolved: requested, how: "exact" };
  return { resolved: "expense:uncategorized", how: "uncategorized_fallback" };
}

async function ingestCommit(opts: CommitOpts): Promise<void> {
  const items = await readStdinTransactions();
  if (items.length === 0) fail("USAGE", "no transaction data on stdin");

  const db = await openDb();
  const { commitTransaction, defaultCommitHooks } = await import("../../scanner/commit.js");
  const { getTransaction } = await import("../../db/queries/transactions.js");
  const { findAccountById } = await import("../../db/queries/account-balance.js");
  const accountExists = (id: string): boolean => !!findAccountById(db, id);

  // ALWAYS have a scanId: defaultCommitHooks.raise() early-returns when scanId
  // is null (commit.ts), which silently drops every question. Minted once per
  // invocation unless the caller supplied one.
  const scanId = opts.scanId ?? `sc:${randomUUID()}`;

  const results: Record<string, unknown>[] = [];
  let posted = 0;
  let failed = 0;
  let raisedTotal = 0;

  for (let index = 0; index < items.length; index++) {
    const item: any = items[index];
    const sourceFileId = (item.source_file_id ?? opts.file) ?? null;
    const txInput = toTransactionInput(item, sourceFileId);

    const ctx: CommitContext = {
      scanId,
      fileId: sourceFileId,
      chunkId: null,
      progress: null,
    };
    const events: CommitEvent[] = [];
    const hooks = makeRecordingHooks(defaultCommitHooks(db, ctx), events);

    const outcome = commitTransaction(db, ctx, txInput, hooks);
    raisedTotal += outcome.raisedQuestions;

    if (!outcome.ok) {
      failed++;
      results.push({
        type: "result",
        index,
        ok: false,
        reason: outcome.reason,
        message: outcome.message,
        raised_questions: outcome.raisedQuestions,
      });
      continue;
    }

    posted++;
    const txId = outcome.transactionId;

    const hadMerchant = !!(item.merchant || item.merchant_id);
    const unknownMerchant = events.some((e) => e.kind === "unknown_merchant");
    let merchant: Record<string, unknown>;
    if (!hadMerchant) {
      merchant = { how: "none" };
    } else if (unknownMerchant) {
      merchant = { how: "unknown" };
    } else {
      const detail = getTransaction(db, txId);
      merchant = { how: "linked", merchant_id: detail?.merchant_id ?? undefined };
    }

    const postings = txInput.postings.map((p, i) => {
      const c = classifyPosting(p.account_id, events, accountExists);
      return { index: i, requested: p.account_id, resolved: c.resolved, how: c.how };
    });

    results.push({
      type: "result",
      index,
      ok: true,
      transaction_id: txId,
      raised_questions: outcome.raisedQuestions,
      merchant,
      postings,
    });
  }

  const mode = currentMode();
  if (mode.json) {
    for (const r of results) emitItem(r);
    emitSummary({ batch_id: scanId, posted, failed, raised_questions: raisedTotal });
  } else {
    for (const r of results) emitObject(r);
    process.stdout.write(
      `\nbatch ${scanId}: ${posted} posted, ${failed} failed, ${raisedTotal} question(s) raised\n`,
    );
  }

  if (failed > 0) process.exitCode = EXIT.PARTIAL;
}

// --- ingest done / fail / clean --------------------------------------------

interface DoneOpts {
  agent?: string;
  note?: string;
}

async function ingestDone(id: string, opts: DoneOpts): Promise<void> {
  const db = await openDb();
  const { markFileScanned } = await import("../../db/queries/files.js");
  const changes = markFileScanned(db, id, { source: opts.agent ?? "external" });
  if (changes === 0) fail("NOT_FOUND", `no ingest entry: ${id}`);

  const { cleanCache } = await import("../../scanner/ingest.js");
  const { removed } = cleanCache(id);
  const out: Record<string, unknown> = { file_id: id, status: "scanned", cache_removed: removed };
  // --note is informational only; echoed back but not persisted.
  if (opts.note !== undefined) out.note = opts.note;
  emitObject(out);
}

interface FailOpts {
  agent?: string;
  error?: string;
}

async function ingestFail(id: string, opts: FailOpts): Promise<void> {
  if (!opts.error) fail("USAGE", "`ingest fail` requires --error <text>");

  const db = await openDb();
  const { markFileFailed } = await import("../../db/queries/files.js");
  const changes = markFileFailed(db, id, { source: opts.agent ?? "external", error: opts.error });
  if (changes === 0) fail("NOT_FOUND", `no ingest entry: ${id}`);

  emitObject({ file_id: id, status: "failed", cache_removed: [] });
}

interface CleanOpts {
  file?: string;
}

async function ingestClean(opts: CleanOpts): Promise<void> {
  const { cleanCache } = await import("../../scanner/ingest.js");
  const { removed } = cleanCache(opts.file);
  emitObject({ removed });
}


// --- registration ----------------------------------------------------------

export function registerIngest(program: Command): void {
  const ingest = program.command("ingest").description("Ingest pipeline");

  ingest
    .command("list")
    .description("List items in the ingest pipeline")
    .option("--regex <pattern>", "filter items by regex")
    .action(runAction(ingestList));

  ingest
    .command("prepare <pathOrId>")
    .description("Prepare a file for ingestion")
    .option("--password-stdin", "read a password from stdin")
    .option("--force", "overwrite existing prepared output")
    .option("--format <fmt>", "output format (png|pdf)")
    .option("--dpi <n>", "rasterization resolution in DPI")
    .option("--pages <spec>", "page range to prepare (1-based, e.g. all | 1-5,8)")
    .option("--out <dir>", "output directory")
    .action(runAction(ingestPrepare));

  ingest
    .command("commit")
    .description("Commit prepared transactions (NDJSON/JSON array on stdin) into the ledger")
    .option("--file <id>", "default source file id for committed rows")
    .option("--scan-id <id>", "scan id to attach questions to (minted when omitted)")
    .action(runAction(ingestCommit));

  ingest
    .command("done <id>")
    .description("Mark an ingest item as done")
    .option("--agent <name>", "name of the completing agent")
    .option("--note <text>", "completion note")
    .action(runAction(ingestDone));

  ingest
    .command("fail <id>")
    .description("Mark an ingest item as failed")
    .option("--agent <name>", "name of the failing agent")
    .option("--error <text>", "failure reason")
    .action(runAction(ingestFail));

  ingest
    .command("clean")
    .description("Clean up prepared ingest artifacts")
    .option("--file <id>", "file id to clean")
    .action(runAction(ingestClean));
}
