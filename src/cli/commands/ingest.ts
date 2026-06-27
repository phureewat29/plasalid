import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { resolve } from "path";
import type { Command } from "commander";
import type {
  TransferCommitContext,
  TransferCommitHooks,
  TransferSide,
  RawTransferInput,
  LinkedTransferHeader,
  LinkedTransferLeg,
} from "../../scanner/commit-transfer.js";
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
 * interactive TUI: list candidate files, prepare pages, commit extracted rows
 * as transfers, and mark files done/failed. Heavy db/scanner imports are
 * deferred inside each action so non-db commands don't pay for libsql/mupdf at
 * startup (mirrors the pattern in status.ts).
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

type SideHow = "exact" | "fuzzy_matched" | "placeholder_created" | "uncategorized_fallback";

type CommitEvent =
  | { kind: "placeholder"; side: TransferSide; accountId: string }
  | { kind: "fuzzy"; side: TransferSide; originalId: string; matchedId: string }
  | { kind: "unknown_merchant"; attemptedId: string }
  | { kind: "dirty"; reason: string }
  | { kind: "currency_mismatch" };

/** Wrap the default hooks so every raised question still fires (delegated to
 *  the default), while we also capture a typed event per callback to build the
 *  per-side resolution report afterwards. */
function makeRecordingHooks(base: TransferCommitHooks, events: CommitEvent[]): TransferCommitHooks {
  return {
    onCommitted: (id) => base.onCommitted(id),
    onDirtyInput: (input, reason) => {
      base.onDirtyInput(input, reason);
      events.push({ kind: "dirty", reason });
    },
    onUnknownMerchant: (input, id, attemptedId) => {
      base.onUnknownMerchant(input, id, attemptedId);
      events.push({ kind: "unknown_merchant", attemptedId });
    },
    onPlaceholderAccount: (side, accountId, id) => {
      base.onPlaceholderAccount(side, accountId, id);
      events.push({ kind: "placeholder", side, accountId });
    },
    onSimilarAccount: (side, originalId, matchedId, id) => {
      base.onSimilarAccount(side, originalId, matchedId, id);
      events.push({ kind: "fuzzy", side, originalId, matchedId });
    },
    onCurrencyMismatch: (input, debit, credit) => {
      base.onCurrencyMismatch(input, debit, credit);
      events.push({ kind: "currency_mismatch" });
    },
  };
}

/**
 * Classify how an input side's account_id was resolved. Derived from the
 * captured hook events + a post-commit existence check — NOT from the stored
 * row (a duplicate re-commit fires no hooks, so absence of an event on an
 * existing account reads correctly as "exact").
 */
function classifySide(
  requested: string,
  side: TransferSide,
  events: CommitEvent[],
  accountExists: (id: string) => boolean,
): { resolved: string; how: SideHow } {
  const fuzzy = events.find(
    (e): e is Extract<CommitEvent, { kind: "fuzzy" }> =>
      e.kind === "fuzzy" && e.side === side && e.originalId === requested,
  );
  if (fuzzy) return { resolved: fuzzy.matchedId, how: "fuzzy_matched" };

  const placeholder = events.find(
    (e) => e.kind === "placeholder" && e.side === side && e.accountId === requested,
  );
  if (placeholder) return { resolved: requested, how: "placeholder_created" };

  if (accountExists(requested)) return { resolved: requested, how: "exact" };
  return { resolved: "expense:uncategorized", how: "uncategorized_fallback" };
}

function classifyMerchant(
  item: any,
  events: CommitEvent[],
  resolvedMerchantId: () => string | null | undefined,
): { how: string; merchant_id?: string } {
  const hadMerchant = !!(item.merchant || item.merchant_id);
  if (!hadMerchant) return { how: "none" };
  if (events.some((e) => e.kind === "unknown_merchant")) return { how: "unknown" };
  const mid = resolvedMerchantId();
  return { how: "linked", merchant_id: mid ?? undefined };
}

async function ingestCommit(opts: CommitOpts): Promise<void> {
  const items = await readStdinTransactions();
  if (items.length === 0) fail("USAGE", "no transaction data on stdin");

  const db = await openDb();
  const { commitTransfer, commitLinkedTransfers, defaultTransferCommitHooks } = await import(
    "../../scanner/commit-transfer.js"
  );
  const { getTransfer } = await import("../../db/queries/transfers.js");
  const { findAccountById } = await import("../../db/queries/account-balance.js");
  const { findScannedFileById } = await import("../../db/queries/files.js");
  const accountExists = (id: string): boolean => !!findAccountById(db, id);

  // ALWAYS have a scanId: defaultTransferCommitHooks.raise() early-returns when
  // scanId is null, which silently drops every question. Minted once per
  // invocation unless the caller supplied one.
  const scanId = opts.scanId ?? `sc:${randomUUID()}`;

  // Derive the deterministic-id source hash from the scanned_files row (cached).
  const fileHashCache = new Map<string, string | null>();
  const fileHashFor = (fileId: string | null): string | null => {
    if (!fileId) return null;
    if (!fileHashCache.has(fileId)) {
      fileHashCache.set(fileId, findScannedFileById(db, fileId)?.file_hash ?? null);
    }
    return fileHashCache.get(fileId) ?? null;
  };

  const results: Record<string, unknown>[] = [];
  let posted = 0;
  let duplicates = 0;
  let failed = 0;
  let raisedTotal = 0;

  for (let index = 0; index < items.length; index++) {
    const item: any = items[index];
    const fileId = (item.source_file_id ?? opts.file) ?? null;
    const ctx: TransferCommitContext = {
      scanId,
      fileId,
      fileHash: fileHashFor(fileId),
      chunkId: null,
      progress: null,
    };
    const events: CommitEvent[] = [];
    const hooks = makeRecordingHooks(defaultTransferCommitHooks(db, ctx), events);

    const isCompound = Array.isArray(item.linked) && item.linked.length > 0;

    if (isCompound) {
      const header: LinkedTransferHeader = {
        date: item.date,
        description: item.description,
        raw_descriptor: item.raw_descriptor ?? null,
        source_file_id: fileId,
        source_page: item.source_page ?? null,
        merchant: item.merchant ?? null,
        merchant_id: item.merchant_id ?? null,
        group_id: item.group_id ?? null,
        row_index: item.row_index ?? null,
      };
      const legs: LinkedTransferLeg[] = item.linked.map((l: any) => ({
        debit_account_id: l.debit_account ?? l.debit_account_id,
        credit_account_id: l.credit_account ?? l.credit_account_id,
        amount: l.amount,
        currency: l.currency ?? null,
        description: l.description,
        code: l.code ?? null,
      }));

      const outcome = commitLinkedTransfers(db, ctx, header, legs, hooks);
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

      const allDuplicate = outcome.results.every((r) => r.duplicate);
      if (allDuplicate) duplicates++;
      else posted++;

      results.push({
        type: "result",
        index,
        ok: true,
        group_id: outcome.group_id,
        legs: outcome.results.map((r) => ({ transfer_id: r.id, duplicate: r.duplicate })),
        duplicate: allDuplicate,
        raised_questions: outcome.raisedQuestions,
        merchant: classifyMerchant(item, events, () =>
          getTransfer(db, outcome.results[0]?.id)?.merchant_id,
        ),
      });
      continue;
    }

    // Standalone transfer.
    const raw: RawTransferInput = {
      id: item.id ?? undefined,
      date: item.date,
      description: item.description,
      raw_descriptor: item.raw_descriptor ?? null,
      source_file_id: fileId,
      source_page: item.source_page ?? null,
      row_index: item.row_index ?? null,
      merchant: item.merchant ?? null,
      merchant_id: item.merchant_id ?? null,
      debit_account_id: item.debit_account ?? item.debit_account_id,
      credit_account_id: item.credit_account ?? item.credit_account_id,
      amount: item.amount,
      currency: item.currency ?? null,
      code: item.code ?? null,
    };

    const outcome = commitTransfer(db, ctx, raw, hooks);
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

    if (outcome.duplicate) duplicates++;
    else posted++;

    results.push({
      type: "result",
      index,
      ok: true,
      transfer_id: outcome.transferId,
      duplicate: outcome.duplicate,
      raised_questions: outcome.raisedQuestions,
      merchant: classifyMerchant(item, events, () => getTransfer(db, outcome.transferId)?.merchant_id),
      sides: [
        {
          side: "debit",
          requested: raw.debit_account_id,
          ...classifySide(raw.debit_account_id, "debit", events, accountExists),
        },
        {
          side: "credit",
          requested: raw.credit_account_id,
          ...classifySide(raw.credit_account_id, "credit", events, accountExists),
        },
      ],
    });
  }

  const mode = currentMode();
  if (mode.json) {
    for (const r of results) emitItem(r);
    emitSummary({ batch_id: scanId, posted, duplicates, failed, raised_questions: raisedTotal });
  } else {
    for (const r of results) emitObject(r);
    process.stdout.write(
      `\nbatch ${scanId}: ${posted} posted, ${duplicates} duplicate(s), ${failed} failed, ${raisedTotal} question(s) raised\n`,
    );
  }

  // Exit 7 only for genuine failures — duplicates are a successful no-op.
  if (failed > 0) process.exitCode = EXIT.PARTIAL;
}

// --- ingest done / fail ----------------------------------------------------

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

  const { cleanCache } = await import("../../scanner/ingest.js");
  const { removed } = cleanCache(id);
  emitObject({ file_id: id, status: "failed", cache_removed: removed });
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
    .description("Commit prepared transfers (NDJSON/JSON array on stdin) into the ledger")
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
}
