import type Database from "libsql";
import chalk from "chalk";
import inquirer from "inquirer";
import { readPdf } from "./pdf.js";
import { unlockIfNeeded, persistUnlockOutcome } from "./unlock.js";
import type { ScannedFile } from "./walker.js";

export interface DecryptedFile {
  path: string;
  fileName: string;
  relPath: string;
  hash: string;
  mime: string;
  decryptedBytes: Buffer;
  /** True if a prior scan covered this hash; only present when --force is set. */
  replacesPriorScannedFileId?: string;
}

export interface SkippedFile {
  file: ScannedFile;
  /** id of the scanned_files row that already has this hash. */
  existingScannedFileId: string;
}

export interface FailedFile {
  file: ScannedFile;
  error: string;
}

export interface DecryptQueueResult {
  decrypted: DecryptedFile[];
  skipped: SkippedFile[];
  failed: FailedFile[];
}

export interface DecryptQueueOptions {
  /** Re-decrypt and queue files that match a prior hash. */
  force: boolean;
  /** If false, never prompt for a password; treat unlock failure as failed. */
  interactive: boolean;
  /** Called as each file finishes (any outcome) so a spinner can update its label. */
  onProgress?: (event: { index: number; total: number; fileName: string; outcome: "decrypted" | "skipped" | "failed" }) => void;
}

/**
 * Phase 1 of scan: walk every file in the queue, decrypt any that need it,
 * and return a partition (decrypted / skipped / failed). The actual agent
 * work in Phase 2 only sees `decrypted` — no password prompts during the
 * parallel scan loop.
 *
 * Failures don't abort; the caller (CLI) confirms whether to proceed.
 */
export async function decryptQueue(
  db: Database.Database,
  files: ScannedFile[],
  opts: DecryptQueueOptions,
): Promise<DecryptQueueResult> {
  const decrypted: DecryptedFile[] = [];
  const skipped: SkippedFile[] = [];
  const failed: FailedFile[] = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let pdf;
    try {
      pdf = readPdf(f.path);
    } catch (err: any) {
      failed.push({ file: f, error: `read failed: ${err.message}` });
      opts.onProgress?.({ index: i, total: files.length, fileName: f.name, outcome: "failed" });
      continue;
    }

    const existing = findScannedByHash(db, pdf.hash);
    if (existing && !opts.force) {
      skipped.push({ file: f, existingScannedFileId: existing.id });
      opts.onProgress?.({ index: i, total: files.length, fileName: f.name, outcome: "skipped" });
      continue;
    }

    try {
      const unlocked = await unlockIfNeeded({
        db,
        filePath: f.path,
        bytes: pdf.bytes,
        interactive: opts.interactive,
      });
      persistUnlockOutcome(db, f.path, unlocked.outcome);
      decrypted.push({
        path: f.path,
        fileName: f.name,
        relPath: f.relPath,
        hash: pdf.hash,
        mime: pdf.mime,
        decryptedBytes: unlocked.decrypted,
        replacesPriorScannedFileId: existing?.id,
      });
      opts.onProgress?.({ index: i, total: files.length, fileName: f.name, outcome: "decrypted" });
    } catch (err: any) {
      failed.push({ file: f, error: err.message ?? "unlock failed" });
      opts.onProgress?.({ index: i, total: files.length, fileName: f.name, outcome: "failed" });
    }
  }

  return { decrypted, skipped, failed };
}

/**
 * Interactive go/no-go gate when some files failed to decrypt. Returns true
 * if the caller should proceed with the decrypted set, false to abort the
 * whole scan run.
 *
 * Returns true automatically when interactive is false (CI / non-TTY runs);
 * the caller is expected to inspect `result.failed` and report.
 */
export async function confirmProceedAfterFailures(
  result: DecryptQueueResult,
  interactive: boolean,
): Promise<boolean> {
  if (result.failed.length === 0) return true;
  console.log("");
  console.log(chalk.yellow(`${result.failed.length} file(s) could not be decrypted:`));
  for (const f of result.failed) {
    console.log(`  ${chalk.red("✗")} ${f.file.relPath} — ${chalk.dim(f.error)}`);
  }
  if (result.decrypted.length === 0) {
    console.log(chalk.red("Nothing to scan."));
    return false;
  }
  if (!interactive) return true;
  const { proceed } = (await inquirer.prompt([
    {
      type: "confirm",
      name: "proceed",
      message: `Proceed scanning the ${result.decrypted.length} file(s) that decrypted successfully?`,
      default: true,
    },
  ])) as { proceed: boolean };
  return proceed;
}

function findScannedByHash(db: Database.Database, hash: string): { id: string } | null {
  return (db
    .prepare(`SELECT id FROM scanned_files WHERE file_hash = ?`)
    .get(hash) as { id: string } | undefined) ?? null;
}
