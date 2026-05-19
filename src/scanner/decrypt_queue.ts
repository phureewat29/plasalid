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

type DecryptOutcome =
  | { kind: "decrypted"; file: DecryptedFile }
  | { kind: "skipped"; existingScannedFileId: string }
  | { kind: "failed"; error: string };

async function decryptOne(
  db: Database.Database,
  file: ScannedFile,
  opts: { force: boolean; interactive: boolean },
): Promise<DecryptOutcome> {
  let pdf;
  try {
    pdf = readPdf(file.path);
  } catch (err) {
    return { kind: "failed", error: `read failed: ${errorMessage(err)}` };
  }

  const existing = findScannedByHash(db, pdf.hash);
  if (existing && !opts.force) {
    return { kind: "skipped", existingScannedFileId: existing.id };
  }

  try {
    const unlocked = await unlockIfNeeded({
      db,
      filePath: file.path,
      bytes: pdf.bytes,
      interactive: opts.interactive,
    });
    persistUnlockOutcome(db, file.path, unlocked.outcome);
    return {
      kind: "decrypted",
      file: {
        path: file.path,
        fileName: file.name,
        relPath: file.relPath,
        hash: pdf.hash,
        mime: pdf.mime,
        decryptedBytes: unlocked.decrypted,
        replacesPriorScannedFileId: existing?.id,
      },
    };
  } catch (err) {
    return { kind: "failed", error: errorMessage(err) || "unlock failed" };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    const file = files[i];
    const outcome = await decryptOne(db, file, opts);
    const progress = (kind: "decrypted" | "skipped" | "failed") =>
      opts.onProgress?.({ index: i, total: files.length, fileName: file.name, outcome: kind });

    switch (outcome.kind) {
      case "decrypted":
        decrypted.push(outcome.file);
        progress("decrypted");
        break;
      case "skipped":
        skipped.push({ file, existingScannedFileId: outcome.existingScannedFileId });
        progress("skipped");
        break;
      case "failed":
        failed.push({ file, error: outcome.error });
        progress("failed");
        break;
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
