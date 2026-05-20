import type Database from "libsql";
import { randomUUID } from "crypto";
import { getDb } from "../db/connection.js";
import { countOpenUnknowns } from "../db/queries/unknowns.js";
import { runInspectors, type InspectionRunResult } from "./inspectors/index.js";
import { runScanAgent } from "../ai/agent.js";
import { buildDocumentBlock } from "./pdf.js";
import { buildScanUserMessage } from "./prompts.js";
import { scanDataDir } from "./walker.js";
import { BufferedWriteContext } from "./buffer.js";
import { runWithConcurrency } from "./concurrency.js";
import {
  decryptQueue,
  confirmProceedAfterFailures,
  type DecryptedFile,
  type DecryptQueueResult,
} from "./decrypt-queue.js";
import type { NormalizedMessage } from "../ai/provider.js";

export type ScanFileStatus = "scanned" | "replaced" | "failed" | "skipped";

export interface ScanFileResult {
  name: string;
  relPath: string;
  status: ScanFileStatus;
  transactions: number;
  unknowns: number;
  error?: string;
}

export interface ScanSummary {
  total: number;
  scanned: number;
  replaced: number;
  skipped: number;
  failed: number;
  unknowns: number;
  details: ScanFileResult[];
}

/** Event hooks the CLI subscribes to. All callbacks are best-effort and ignored if absent. */
export interface ScanRunEvents {
  decryptStart?: (count: number) => void;
  decryptProgress?: (e: { index: number; total: number; fileName: string; outcome: "decrypted" | "skipped" | "failed" }) => void;
  decryptDone?: (e: { decrypted: number; skipped: number; failed: number }) => void;
  scanStart?: (e: { fileName: string }) => void;
  scanProgress?: (e: { fileName: string; step: string }) => void;
  scanEnd?: (e: { fileName: string; status: "scanned" | "failed"; transactions: number; unknowns: number; error?: string }) => void;
  committing?: () => void;
  /** Post-commit inspector pass. `result.total` is the count of unknowns emitted by all inspectors combined. */
  inspecting?: (result: InspectionRunResult) => void;
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

/** Orchestration */

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

  // Phase 3 — per-file commit
  events?.committing?.();
  const { details, committedFileIds } = commitAll(db, decryptResult, scanResults);

  // Phase 4 — post-commit inspector sweep (duplicates, correlations, recurrences, similar accounts)
  if (committedFileIds.length > 0) {
    const inspectionResult = runInspectors(db, { fileIds: committedFileIds });
    events?.inspecting?.(inspectionResult);
    addInspectionUnknownsToSummary(details, committedFileIds, inspectionResult.total);
  }

  return buildSummary(allFiles.length, details);
}

/**
 * Inspector unknowns were inserted after the per-file commit, so the per-file
 * `unknowns` counters in `details` don't see them. Spread the total across the
 * files that participated in this run so the summary's `unknowns` line stays
 * truthful. Distribution is per-file proportional — good enough for a summary,
 * not a load-bearing fact.
 */
function addInspectionUnknownsToSummary(
  details: ScanFileResult[],
  committedFileIds: readonly string[],
  total: number,
): void {
  if (total === 0 || committedFileIds.length === 0) return;
  const scannedDetails = details.filter(d => d.status === "scanned" || d.status === "replaced");
  if (scannedDetails.length === 0) return;
  const perFile = Math.floor(total / scannedDetails.length);
  const remainder = total - perFile * scannedDetails.length;
  for (let i = 0; i < scannedDetails.length; i++) {
    scannedDetails[i].unknowns += perFile + (i < remainder ? 1 : 0);
  }
}

/** Phase 2: parallel scan */

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
  // scanOneFile catches LLM errors and returns ScanWorkResult with `error` set,
  // so a !r.ok slot here only fires for truly unexpected throws.
  return settled.map((r, i) => {
    if (r.ok) return r.value;
    return {
      decryptedFile: files[i],
      buffer: new BufferedWriteContext(files[i].fileName),
      error: String(r.error),
      agentText: "",
    };
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
      transactions: buffer.transactions.length,
      unknowns: buffer.unknowns.length,
    });
    return { decryptedFile: file, buffer, agentText: text };
  } catch (err: any) {
    const message = err?.message ?? "agent error";
    events?.scanEnd?.({
      fileName: file.fileName,
      status: "failed",
      transactions: 0,
      unknowns: 0,
      error: message,
    });
    return { decryptedFile: file, buffer, error: message, agentText: "" };
  }
}

/** Phase 3: commit */

interface CommitOutput {
  details: ScanFileResult[];
  committedFileIds: string[];
}

function commitAll(
  db: Database.Database,
  decryptResult: DecryptQueueResult,
  scanResults: ScanWorkResult[],
): CommitOutput {
  const details: ScanFileResult[] = [];
  const committedFileIds: string[] = [];

  for (const skipped of decryptResult.skipped) {
    details.push({
      name: skipped.file.name,
      relPath: skipped.file.relPath,
      status: "skipped",
      transactions: 0,
      unknowns: countOpenUnknowns(db, { file_id: skipped.existingScannedFileId }),
    });
  }

  for (const failed of decryptResult.failed) {
    details.push({
      name: failed.file.name,
      relPath: failed.file.relPath,
      status: "failed",
      transactions: 0,
      unknowns: 0,
      error: failed.error,
    });
  }

  for (const res of scanResults) {
    const { decryptedFile, buffer, error, agentText } = res;
    if (error) {
      details.push({
        name: decryptedFile.fileName,
        relPath: decryptedFile.relPath,
        status: "failed",
        transactions: 0,
        unknowns: buffer.unknowns.length,
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
      committedFileIds.push(scannedFileId);
      details.push({
        name: decryptedFile.fileName,
        relPath: decryptedFile.relPath,
        status: decryptedFile.replacesPriorScannedFileId ? "replaced" : "scanned",
        transactions: counts.transactions,
        unknowns: counts.unknowns,
      });
    } catch (err: any) {
      details.push({
        name: decryptedFile.fileName,
        relPath: decryptedFile.relPath,
        status: "failed",
        transactions: 0,
        unknowns: buffer.unknowns.length,
        error: err?.message ?? "commit failed",
      });
    }
  }

  return { details, committedFileIds };
}

/** Summary assembly */

function buildSummary(total: number, details: ScanFileResult[]): ScanSummary {
  const summary: ScanSummary = {
    total,
    scanned: 0,
    replaced: 0,
    skipped: 0,
    failed: 0,
    unknowns: 0,
    details,
  };
  for (const d of details) {
    summary[d.status]++;
    summary.unknowns += d.unknowns;
  }
  return summary;
}

function buildAbortedSummary(total: number, decrypt: DecryptQueueResult): ScanSummary {
  const details: ScanFileResult[] = [
    ...decrypt.skipped.map(s => ({
      name: s.file.name, relPath: s.file.relPath, status: "skipped" as const, transactions: 0, unknowns: 0,
    })),
    ...decrypt.failed.map(f => ({
      name: f.file.name, relPath: f.file.relPath, status: "failed" as const, transactions: 0, unknowns: 0, error: f.error,
    })),
  ];
  return buildSummary(total, details);
}

/** Low-level DB helpers */

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
