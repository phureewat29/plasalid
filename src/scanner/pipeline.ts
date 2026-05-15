import type Database from "libsql";
import { randomUUID } from "crypto";
import { getDb } from "../db/connection.js";
import {
  countOpenConcerns,
  recordConcern,
} from "../db/queries/concerns.js";
import { correlatePairs, type CorrelationCandidate } from "../db/queries/journal.js";
import { runScanAgent } from "../ai/agent.js";
import { buildDocumentBlock } from "./pdf.js";
import { buildScanUserMessage } from "./prompts.js";
import { scanDataDir, type ScannedFile } from "./walker.js";
import { BufferedWriteContext } from "./buffer.js";
import { runWithConcurrency } from "./concurrency.js";
import {
  decryptQueue,
  confirmProceedAfterFailures,
  type DecryptedFile,
  type DecryptQueueResult,
} from "./decrypt_queue.js";
import type { NormalizedMessage } from "../ai/provider.js";

export type ScanFileStatus = "scanned" | "replaced" | "failed" | "skipped";

export interface ScanFileResult {
  name: string;
  relPath: string;
  status: ScanFileStatus;
  entries: number;
  concerns: number;
  error?: string;
}

export interface ScanSummary {
  total: number;
  scanned: number;
  replaced: number;
  skipped: number;
  failed: number;
  concerns: number;
  details: ScanFileResult[];
}

/** Event hooks the CLI subscribes to. All callbacks are best-effort and ignored if absent. */
export interface ScanRunEvents {
  decryptStart?: (count: number) => void;
  decryptProgress?: (e: { index: number; total: number; fileName: string; outcome: "decrypted" | "skipped" | "failed" }) => void;
  decryptDone?: (e: { decrypted: number; skipped: number; failed: number }) => void;
  scanStart?: (e: { fileName: string }) => void;
  scanProgress?: (e: { fileName: string; step: string }) => void;
  scanEnd?: (e: { fileName: string; status: "scanned" | "failed"; entries: number; concerns: number; error?: string }) => void;
  correlating?: (pairs: number) => void;
  committing?: () => void;
}

export interface RunScanOptions {
  regex?: string;
  force?: boolean;
  /** Allow interactive password prompts when a PDF is encrypted. */
  interactive?: boolean;
  /** Max concurrent scan agents. Default 3, hard cap 8. */
  concurrency?: number;
  events?: ScanRunEvents;
}

export function compileMatcher(input: string): RegExp {
  return new RegExp(input, "i");
}

// ── Orchestration ───────────────────────────────────────────────────────────

export async function runScan(opts: RunScanOptions = {}): Promise<ScanSummary> {
  const db = getDb();
  const matcher = opts.regex ? compileMatcher(opts.regex) : null;
  const allFiles = scanDataDir().filter(f => (matcher ? matcher.test(f.relPath) : true));
  const concurrency = Math.min(8, Math.max(1, opts.concurrency ?? 3));
  const interactive = opts.interactive ?? true;
  const events = opts.events;

  // Phase 1 — decrypt all
  events?.decryptStart?.(allFiles.length);
  const decryptResult = await decryptQueue(db, allFiles, {
    force: !!opts.force,
    interactive,
    onProgress: events?.decryptProgress,
  });
  events?.decryptDone?.({
    decrypted: decryptResult.decrypted.length,
    skipped: decryptResult.skipped.length,
    failed: decryptResult.failed.length,
  });
  const proceed = await confirmProceedAfterFailures(decryptResult, interactive);
  if (!proceed) {
    return buildAbortedSummary(allFiles.length, decryptResult);
  }

  // Phase 2 — parallel scan with buffered writes
  const scanResults = await scanInParallel(db, decryptResult.decrypted, { concurrency, events });

  // Phase 3 — cross-file correlation pre-commit
  const pairCount = applyCrossFileCorrelations(scanResults);
  events?.correlating?.(pairCount);

  // Phase 4 — per-file commit
  events?.committing?.();
  const fileResults = commitAll(db, decryptResult, scanResults);

  return buildSummary(allFiles.length, fileResults, decryptResult);
}

// ── Phase 2: parallel scan ──────────────────────────────────────────────────

interface ScanWorkResult {
  decryptedFile: DecryptedFile;
  buffer: BufferedWriteContext;
  error?: string;
  /** Agent's raw response text (kept for the scanned_files.raw_text column). */
  agentText: string;
}

async function scanInParallel(
  db: Database.Database,
  files: DecryptedFile[],
  opts: { concurrency: number; events?: ScanRunEvents },
): Promise<ScanWorkResult[]> {
  const tasks = files.map(f => () => scanOneFile(db, f, opts.events));
  const settled = await runWithConcurrency(tasks, opts.concurrency);
  // Worker errors are captured per-slot by runWithConcurrency. scanOneFile
  // itself catches LLM errors and returns a ScanWorkResult with `error` set,
  // so the `{error}` branch only fires for truly unexpected throws.
  return settled.map((r, i) => {
    if (r && typeof r === "object" && "error" in r && !("buffer" in r)) {
      return {
        decryptedFile: files[i],
        buffer: new BufferedWriteContext(files[i].fileName),
        error: String((r as { error: unknown }).error),
        agentText: "",
      };
    }
    return r as ScanWorkResult;
  });
}

async function scanOneFile(
  db: Database.Database,
  file: DecryptedFile,
  events?: ScanRunEvents,
): Promise<ScanWorkResult> {
  const buffer = new BufferedWriteContext(file.fileName);
  events?.scanStart?.({ fileName: file.fileName });

  const block = buildDocumentBlock(file.decryptedBytes, file.fileName, file.mime);
  const messages: NormalizedMessage[] = [
    {
      role: "user",
      content: [
        block,
        { type: "text", text: buildScanUserMessage({ fileName: file.fileName }) },
      ],
    },
  ];

  try {
    const text = await runScanAgent({
      db,
      initialMessages: messages,
      prompt: { fileName: file.fileName },
      agentCtx: {
        interactive: false,
        buffer,
      },
      onProgress: (event) => {
        if (event.phase === "tool" && event.toolName) {
          events?.scanProgress?.({ fileName: file.fileName, step: event.toolName });
        } else if (event.phase === "responding") {
          events?.scanProgress?.({ fileName: file.fileName, step: "thinking" });
        }
      },
    });
    events?.scanEnd?.({
      fileName: file.fileName,
      status: "scanned",
      entries: buffer.journalEntries.length,
      concerns: buffer.concerns.length,
    });
    return { decryptedFile: file, buffer, agentText: text };
  } catch (err: any) {
    const message = err?.message ?? "agent error";
    events?.scanEnd?.({
      fileName: file.fileName,
      status: "failed",
      entries: 0,
      concerns: 0,
      error: message,
    });
    return { decryptedFile: file, buffer, error: message, agentText: "" };
  }
}

// ── Phase 3: cross-file correlation ─────────────────────────────────────────

/**
 * For every pair of buffered entries that look like the same money movement
 * across two different files, append a mirror concern to each side's buffer.
 * Returns the number of pairs detected so the CLI can report it.
 */
function applyCrossFileCorrelations(results: ScanWorkResult[]): number {
  // Map every buffered entry back to its file so we can look up the file name
  // and the right buffer to write the concern into.
  type WithOrigin = { file: ScanWorkResult; entryId: string; lines: { account_id: string; debit?: number; credit?: number; currency?: string }[]; date: string; description: string };
  const all: WithOrigin[] = [];
  for (const res of results) {
    if (res.error) continue;
    for (const be of res.buffer.journalEntries) {
      all.push({
        file: res,
        entryId: be.entry_id,
        lines: be.input.lines,
        date: be.input.date,
        description: be.input.description,
      });
    }
  }

  const candidates: CorrelationCandidate[] = all.map(e => {
    const debit = e.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const currency = e.lines.find(l => l.currency)?.currency ?? "THB";
    const ids = Array.from(new Set(e.lines.map(l => l.account_id)));
    return {
      id: e.entryId,
      date: e.date,
      description: e.description,
      amount: Math.round(debit * 100) / 100,
      currency,
      account_ids: ids,
      account_names: ids,
    };
  });

  const pairs = correlatePairs(candidates, { toleranceDays: 3 });
  const byEntry = new Map(all.map(a => [a.entryId, a]));

  for (const pair of pairs) {
    const a = byEntry.get(pair.a.id);
    const b = byEntry.get(pair.b.id);
    if (!a || !b) continue;
    if (a.file === b.file) continue; // same-file pairs are within-statement dupes; review's own detectors will handle.

    const amountStr = `฿${pair.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    a.file.buffer.appendConcern({
      entry_id: a.entryId,
      account_id: null,
      prompt: `Looks like the matching half of this ${amountStr} movement on ${a.date} was also recorded in ${b.file.decryptedFile.fileName} on ${b.date}. Merge during review?`,
      options: ["Yes — merge into one entry", "No — these are two real events", "Skip — leave as is"],
    });
    b.file.buffer.appendConcern({
      entry_id: b.entryId,
      account_id: null,
      prompt: `Looks like the matching half of this ${amountStr} movement on ${b.date} was also recorded in ${a.file.decryptedFile.fileName} on ${a.date}. Merge during review?`,
      options: ["Yes — merge into one entry", "No — these are two real events", "Skip — leave as is"],
    });
  }

  return pairs.filter(p => byEntry.get(p.a.id)?.file !== byEntry.get(p.b.id)?.file).length;
}

// ── Phase 4: commit ─────────────────────────────────────────────────────────

function commitAll(
  db: Database.Database,
  decryptResult: DecryptQueueResult,
  scanResults: ScanWorkResult[],
): ScanFileResult[] {
  const out: ScanFileResult[] = [];

  // Skipped files: keep them in the summary with their existing concern count.
  for (const skipped of decryptResult.skipped) {
    out.push({
      name: skipped.file.name,
      relPath: skipped.file.relPath,
      status: "skipped",
      entries: 0,
      concerns: countOpenConcerns(db, { file_id: skipped.existingScannedFileId }),
    });
  }

  // Files that failed to decrypt never reached an agent.
  for (const failed of decryptResult.failed) {
    out.push({
      name: failed.file.name,
      relPath: failed.file.relPath,
      status: "failed",
      entries: 0,
      concerns: 0,
      error: failed.error,
    });
  }

  // Scanned files: per-file transaction. Replaces prior records when needed.
  for (const res of scanResults) {
    const { decryptedFile, buffer, error, agentText } = res;
    if (error) {
      out.push({
        name: decryptedFile.fileName,
        relPath: decryptedFile.relPath,
        status: "failed",
        entries: 0,
        concerns: buffer.concerns.length,
        error,
      });
      continue;
    }

    try {
      if (decryptedFile.replacesPriorScannedFileId) {
        deleteScannedFile(db, decryptedFile.replacesPriorScannedFileId);
      }
      const scannedFileId = insertScannedFile(db, {
        path: decryptedFile.path,
        hash: decryptedFile.hash,
        mime: decryptedFile.mime,
      });
      const counts = buffer.commit(db, scannedFileId);
      setFileStatus(db, scannedFileId, "scanned", { raw_text: agentText });
      out.push({
        name: decryptedFile.fileName,
        relPath: decryptedFile.relPath,
        status: decryptedFile.replacesPriorScannedFileId ? "replaced" : "scanned",
        entries: counts.entries,
        concerns: counts.concerns,
      });
    } catch (err: any) {
      out.push({
        name: decryptedFile.fileName,
        relPath: decryptedFile.relPath,
        status: "failed",
        entries: 0,
        concerns: buffer.concerns.length,
        error: err?.message ?? "commit failed",
      });
    }
  }

  return out;
}

// ── Summary assembly ────────────────────────────────────────────────────────

function buildSummary(total: number, details: ScanFileResult[], _decrypt: DecryptQueueResult): ScanSummary {
  const summary: ScanSummary = {
    total,
    scanned: 0,
    replaced: 0,
    skipped: 0,
    failed: 0,
    concerns: 0,
    details,
  };
  for (const d of details) {
    summary[d.status]++;
    summary.concerns += d.concerns;
  }
  return summary;
}

function buildAbortedSummary(total: number, decrypt: DecryptQueueResult): ScanSummary {
  const details: ScanFileResult[] = [
    ...decrypt.skipped.map(s => ({
      name: s.file.name, relPath: s.file.relPath, status: "skipped" as const, entries: 0, concerns: 0,
    })),
    ...decrypt.failed.map(f => ({
      name: f.file.name, relPath: f.file.relPath, status: "failed" as const, entries: 0, concerns: 0, error: f.error,
    })),
  ];
  return buildSummary(total, details, decrypt);
}

// ── Low-level DB helpers ────────────────────────────────────────────────────

function deleteScannedFile(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM scanned_files WHERE id = ?`).run(id);
}

function insertScannedFile(
  db: Database.Database,
  args: { path: string; hash: string; mime: string },
): string {
  const id = `sf:${randomUUID()}`;
  db.prepare(
    `INSERT INTO scanned_files (id, path, file_hash, mime, status)
     VALUES (?, ?, ?, ?, 'pending')`,
  ).run(id, args.path, args.hash, args.mime);
  return id;
}

function setFileStatus(
  db: Database.Database,
  id: string,
  status: "scanned" | "failed",
  fields: { error?: string | null; raw_text?: string | null } = {},
): void {
  db.prepare(
    `UPDATE scanned_files
     SET status = ?, scanned_at = datetime('now'), error = ?, raw_text = COALESCE(?, raw_text)
     WHERE id = ?`,
  ).run(status, fields.error ?? null, fields.raw_text ?? null, id);
}
