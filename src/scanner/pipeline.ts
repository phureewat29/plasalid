import type Database from "libsql";
import { randomUUID } from "crypto";
import chalk from "chalk";
import inquirer from "inquirer";
import { basename, relative, sep } from "path";
import { getDb } from "../db/connection.js";
import { config, getDataDir } from "../config.js";
import { runScanAgent } from "../ai/agent.js";
import {
  statusSpinner,
  makePromptUser,
  makeAgentOnProgress,
  type SpinnerLike,
} from "../cli/ux.js";
import { readPdf, buildDocumentBlock } from "./pdf.js";
import { buildScanUserMessage } from "./prompts.js";
import { scanDataDir } from "./walker.js";
import { isEncrypted, unlock } from "./pdf-unlock.js";
import {
  findCandidates,
  savePassword,
  recordUse,
  suggestPattern,
  type StoredPassword,
} from "./password-store.js";
import {
  transition,
  isTerminal,
  type UnlockState,
  type UnlockEvent,
  type UnlockOutcome,
} from "./state-machine.js";
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

// ── Unlock orchestration ────────────────────────────────────────────────────

interface UnlockCtx {
  db: Database.Database;
  filePath: string;
  bytes: Buffer;
  interactive: boolean;
}

async function unlockIfNeeded(ctx: UnlockCtx): Promise<{ decrypted: Buffer; outcome: UnlockOutcome }> {
  let state: UnlockState = { kind: "init" };
  while (!isTerminal(state)) {
    const event = await stepUnlock(state, ctx);
    state = transition(state, event);
  }
  if (state.kind === "failed") {
    throw new Error(state.reason);
  }
  if (state.kind !== "done") {
    throw new Error(`unlock loop exited in non-terminal state ${state.kind}`);
  }
  return { decrypted: state.decrypted, outcome: state.outcome };
}

async function stepUnlock(state: UnlockState, ctx: UnlockCtx): Promise<UnlockEvent> {
  switch (state.kind) {
    case "init": {
      const spinner = statusSpinner(`Inspecting ${basename(ctx.filePath)}...`);
      try {
        const encrypted = await isEncrypted(ctx.bytes);
        if (!encrypted) {
          spinner.succeed(`${basename(ctx.filePath)} is not encrypted.`);
          return { kind: "INSPECTED_PLAINTEXT", bytes: ctx.bytes };
        }
        const candidates = findCandidates(ctx.db, ctx.filePath, config.dbEncryptionKey);
        spinner.info(`${basename(ctx.filePath)} is encrypted (${candidates.length} saved password${candidates.length === 1 ? "" : "s"} match).`);
        return { kind: "INSPECTED_ENCRYPTED", candidates };
      } catch (err) {
        spinner.fail("Inspection failed.");
        throw err;
      }
    }

    case "trying-stored":
      return await tryStoredPasswords(ctx.bytes, state.candidates);

    case "awaiting-user": {
      if (!ctx.interactive) {
        return { kind: "USER_CANCELLED" };
      }
      const password = await promptForPassword(basename(ctx.filePath), state.attempt);
      if (!password) {
        return { kind: "USER_CANCELLED" };
      }
      const spinner = statusSpinner("Decrypting...");
      const result = await unlock(ctx.bytes, password);
      if (result.ok && result.decrypted) {
        spinner.succeed("Decrypted.");
        return { kind: "UNLOCK_OK", decrypted: result.decrypted, password };
      }
      spinner.fail(`Incorrect password (attempt ${state.attempt}/3).`);
      return { kind: "UNLOCK_FAIL" };
    }

    default:
      throw new Error(`stepUnlock called with terminal state ${state.kind}`);
  }
}

async function tryStoredPasswords(
  bytes: Buffer,
  candidates: StoredPassword[],
): Promise<UnlockEvent> {
  if (candidates.length === 0) {
    return { kind: "STORED_UNLOCK_EXHAUSTED" };
  }
  const spinner = statusSpinner(`Trying saved password 1/${candidates.length}...`);
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    spinner.text = `Trying saved password ${i + 1}/${candidates.length} (pattern ${cand.pattern})`;
    const result = await unlock(bytes, cand.password);
    if (result.ok && result.decrypted) {
      spinner.succeed(`Unlocked with saved password (pattern ${cand.pattern}).`);
      return { kind: "STORED_UNLOCK_OK", decrypted: result.decrypted, usedStoredId: cand.id };
    }
  }
  spinner.info("No saved password matched. Asking the user.");
  return { kind: "STORED_UNLOCK_EXHAUSTED" };
}

async function promptForPassword(fileName: string, attempt: number): Promise<string> {
  const message = attempt === 1
    ? `This PDF is encrypted. Password for ${fileName}:`
    : `Password for ${fileName} (attempt ${attempt}/3):`;
  const { password } = await inquirer.prompt([
    { type: "password", name: "password", mask: "*", message },
  ]);
  return String(password ?? "").trim();
}

function persistUnlockOutcome(
  db: Database.Database,
  filePath: string,
  outcome: UnlockOutcome,
): void {
  if (outcome.kind === "from-store") {
    recordUse(db, outcome.storedId);
    return;
  }
  if (outcome.kind === "from-user") {
    const pattern = suggestPattern(filePath);
    const spinner = statusSpinner(`Saving password for pattern ${pattern}...`);
    try {
      savePassword(db, pattern, outcome.password, config.dbEncryptionKey);
      spinner.succeed(`Saved password for pattern ${pattern}.`);
    } catch (err: any) {
      spinner.fail(`Could not save password: ${err.message}`);
      throw err;
    }
  }
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

// ── Undo (unchanged contract; kept here so commands.ts only imports this file) ──

export interface UndoMatch {
  id: string;
  path: string;
  relPath: string;
  scannedAt: string | null;
}

function pathToRelPath(absolutePath: string): string {
  return relative(getDataDir(), absolutePath).split(sep).join("/");
}

export function findUndoMatches(db: Database.Database, regex: string): UndoMatch[] {
  const matcher = compileMatcher(regex);
  const rows = db
    .prepare(`SELECT id, path, scanned_at FROM scanned_files ORDER BY scanned_at DESC, created_at DESC`)
    .all() as { id: string; path: string; scanned_at: string | null }[];
  return rows
    .map(r => ({ id: r.id, path: r.path, relPath: pathToRelPath(r.path), scannedAt: r.scanned_at }))
    .filter(r => matcher.test(r.relPath));
}

export function deleteMatches(db: Database.Database, ids: string[]): number {
  if (ids.length === 0) return 0;
  const stmt = db.prepare(`DELETE FROM scanned_files WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const id of ids) stmt.run(id);
  });
  tx();
  return ids.length;
}
