import type Database from "libsql";
import { randomUUID } from "crypto";
import { getDb } from "../db/connection.js";
import { runScanAgent } from "../ai/agent.js";
import {
  statusSpinner,
  makePromptUser,
  makeAgentOnProgress,
} from "../cli/ux.js";
import { readPdf, buildDocumentBlock } from "./pdf.js";
import { buildScanUserMessage } from "./prompts.js";
import { scanDataDir } from "./walker.js";
import { unlockIfNeeded, persistUnlockOutcome } from "./unlock.js";
import type { NormalizedMessage } from "../ai/provider.js";

export interface ScanFileResult {
  fileId: string | null;
  status: "scanned" | "needs_input" | "failed" | "skipped" | "replaced";
  summary?: string;
  error?: string;
  pendingQuestions: number;
}

export interface ScanOptions {
  interactive?: boolean;
  force?: boolean;
  onProgress?: (msg: string) => void;
}

// ── DB helpers ──────────────────────────────────────────────────────────────

function findScannedByHash(db: Database.Database, hash: string): { id: string } | null {
  return (db
    .prepare(`SELECT id FROM scanned_files WHERE file_hash = ?`)
    .get(hash) as { id: string } | undefined) ?? null;
}

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

function countPendingQuestions(db: Database.Database, fileId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM pending_questions WHERE file_id = ? AND resolved_at IS NULL`)
    .get(fileId) as { n: number };
  return row.n;
}

function setFileStatus(
  db: Database.Database,
  id: string,
  status: "scanned" | "needs_input" | "failed",
  fields: { error?: string | null; raw_text?: string | null } = {},
): void {
  db.prepare(
    `UPDATE scanned_files
     SET status = ?, scanned_at = datetime('now'), error = ?, raw_text = COALESCE(?, raw_text)
     WHERE id = ?`,
  ).run(status, fields.error ?? null, fields.raw_text ?? null, id);
}

// ── Per-file scan ───────────────────────────────────────────────────────────

export async function scanFile(filePath: string, opts: ScanOptions = {}): Promise<ScanFileResult> {
  const db = getDb();
  const file = readPdf(filePath);

  const existing = findScannedByHash(db, file.hash);
  if (existing && !opts.force) {
    return { fileId: existing.id, status: "skipped", pendingQuestions: countPendingQuestions(db, existing.id) };
  }
  const wasReplaced = !!existing;
  if (existing) {
    deleteScannedFile(db, existing.id);
  }

  let unlocked;
  try {
    unlocked = await unlockIfNeeded({
      db,
      filePath,
      bytes: file.bytes,
      interactive: opts.interactive ?? true,
    });
  } catch (err: any) {
    return { fileId: null, status: "failed", error: err.message, pendingQuestions: 0 };
  }

  persistUnlockOutcome(db, filePath, unlocked.outcome);

  const fileId = insertScannedFile(db, { path: filePath, hash: file.hash, mime: file.mime });
  const block = buildDocumentBlock(unlocked.decrypted, file.fileName, file.mime);
  const messages: NormalizedMessage[] = [
    {
      role: "user",
      content: [
        block,
        { type: "text", text: buildScanUserMessage({ fileName: file.fileName }) },
      ],
    },
  ];

  const spinner = statusSpinner(`Scanning ${file.fileName}...`);

  let summary = "";
  try {
    const text = await runScanAgent({
      db,
      initialMessages: messages,
      prompt: { fileName: file.fileName },
      agentCtx: {
        fileId,
        interactive: opts.interactive ?? true,
        promptUser: opts.interactive === false ? undefined : makePromptUser(spinner),
        onComplete: (s) => { summary = s; },
      },
      onProgress: makeAgentOnProgress(spinner, file.fileName),
    });
    const stillPending = countPendingQuestions(db, fileId);
    if (stillPending > 0) {
      setFileStatus(db, fileId, "needs_input", { raw_text: text });
      spinner.info(`${file.fileName} needs input (${stillPending} pending).`);
      return { fileId, status: "needs_input", summary: summary || text, pendingQuestions: stillPending };
    }
    setFileStatus(db, fileId, "scanned", { raw_text: text });
    spinner.succeed(`Scanned ${file.fileName}.`);
    return {
      fileId,
      status: wasReplaced ? "replaced" : "scanned",
      summary: summary || text,
      pendingQuestions: 0,
    };
  } catch (err: any) {
    setFileStatus(db, fileId, "failed", { error: err.message });
    spinner.fail(`${file.fileName} failed: ${err.message}`);
    return { fileId, status: "failed", error: err.message, pendingQuestions: countPendingQuestions(db, fileId) };
  }
}

// ── Multi-file run ──────────────────────────────────────────────────────────

export interface ScanSummary {
  total: number;
  scanned: number;
  replaced: number;
  skipped: number;
  needsInput: number;
  failed: number;
  details: { name: string; relPath: string; result: ScanFileResult }[];
}

export interface RunScanOptions extends ScanOptions {
  /** Optional regex (string). Partial, case-insensitive, against the relative path. */
  regex?: string;
}

export function compileMatcher(input: string): RegExp {
  return new RegExp(input, "i");
}

export async function runScan(opts: RunScanOptions = {}): Promise<ScanSummary> {
  const matcher = opts.regex ? compileMatcher(opts.regex) : null;
  const files = scanDataDir().filter(f => (matcher ? matcher.test(f.relPath) : true));

  const summary: ScanSummary = {
    total: files.length,
    scanned: 0,
    replaced: 0,
    skipped: 0,
    needsInput: 0,
    failed: 0,
    details: [],
  };
  for (const f of files) {
    const result = await scanFile(f.path, opts);
    summary.details.push({ name: f.name, relPath: f.relPath, result });
    if (result.status === "scanned") summary.scanned++;
    else if (result.status === "replaced") summary.replaced++;
    else if (result.status === "skipped") summary.skipped++;
    else if (result.status === "needs_input") summary.needsInput++;
    else if (result.status === "failed") summary.failed++;
  }
  return summary;
}
