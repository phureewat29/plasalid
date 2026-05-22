import { randomUUID } from "crypto";
import type Database from "libsql";
import { readPdf, type LoadedFile } from "./pdf/pdf.js";
import { unlockIfNeeded, persistUnlockOutcome } from "./pdf/unlock.js";
import { scanDataDir, type ScannedFile } from "./walker.js";
import { tryExecute } from "./result.js";
import type { DecryptedFile, ScanState } from "./engine.js";
import type { ScanHooks } from "./hooks.js";

type DecryptOutcome =
  | { kind: "decrypted"; file: DecryptedFile }
  | { kind: "skipped"; existingScannedFileId: string }
  | { kind: "failed"; error: string };

function findScannedByHash(db: Database.Database, hash: string): { id: string } | null {
  return (db
    .prepare(`SELECT id FROM scanned_files WHERE file_hash = ?`)
    .get(hash) as { id: string } | undefined) ?? null;
}

async function decryptOne(
  db: Database.Database,
  file: ScannedFile,
  opts: { force: boolean; interactive: boolean },
): Promise<DecryptOutcome> {
  const read = await tryExecute<LoadedFile>(() => readPdf(file.path));
  if (!read.ok) return { kind: "failed", error: `read failed: ${read.error}` };
  const pdf = read.value;

  const existing = findScannedByHash(db, pdf.hash);
  if (existing && !opts.force) {
    return { kind: "skipped", existingScannedFileId: existing.id };
  }

  const unlock = await tryExecute(() => unlockIfNeeded({
    db,
    filePath: file.path,
    bytes: pdf.bytes,
    interactive: opts.interactive,
  }));
  if (!unlock.ok) return { kind: "failed", error: unlock.error || "unlock failed" };

  persistUnlockOutcome(db, file.path, unlock.value.outcome);
  return {
    kind: "decrypted",
    file: {
      path: file.path,
      fileName: file.name,
      relPath: file.relPath,
      hash: pdf.hash,
      mime: pdf.mime,
      decryptedBytes: unlock.value.decrypted,
      replacesPriorScannedFileId: existing?.id,
    },
  };
}

type OutcomeHandler = {
  [K in DecryptOutcome["kind"]]: (state: ScanState, file: ScannedFile, outcome: Extract<DecryptOutcome, { kind: K }>) => void;
};

const APPLY: OutcomeHandler = {
  decrypted: (state, _file, o) => { state.decrypted.push(o.file); },
  skipped:   (state, file, o) => { state.skipped.push({ file, existingScannedFileId: o.existingScannedFileId }); },
  failed:    (state, file, o) => { state.failed.push({ file, error: o.error }); },
};

/**
 * Bootstrap one scanned_files row per decrypted file. Chunk workers later
 * stamp transactions with source_file_id, so the row must exist before any
 * tool writes hit the DB. Status flips to 'scanned' after parse completes.
 */
function bootstrapScannedFiles(db: Database.Database, state: ScanState): void {
  for (const file of state.decrypted) {
    if (file.replacesPriorScannedFileId) {
      db.prepare(`DELETE FROM scanned_files WHERE id = ?`).run(file.replacesPriorScannedFileId);
    }
    const sfId = `sf:${randomUUID()}`;
    db.prepare(
      `INSERT INTO scanned_files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, 'pending')`,
    ).run(sfId, file.path, file.hash, file.mime);
    file.scannedFileId = sfId;
  }
}

/**
 * Phase 1 — walk the data dir, optionally filter by regex, decrypt each file
 * sequentially (password prompts can't share a TTY). Output partitions into
 * decrypted / skipped / failed via a kind-keyed dispatch map. Bootstrapped
 * scanned_files rows are tagged onto each DecryptedFile.
 */
export async function decryptPhase(
  db: Database.Database,
  state: ScanState,
  hooks: ScanHooks,
): Promise<void> {
  await hooks.beforeDecrypt?.(state);

  const matcher = state.options.regex ? new RegExp(state.options.regex, "i") : null;
  state.files = scanDataDir().filter(f => (matcher ? matcher.test(f.relPath) : true));

  const interactive = state.options.interactive ?? true;
  const force = !!state.options.force;

  for (const file of state.files) {
    const outcome = await decryptOne(db, file, { force, interactive });
    (APPLY[outcome.kind] as (s: ScanState, f: ScannedFile, o: DecryptOutcome) => void)(state, file, outcome);
  }

  bootstrapScannedFiles(db, state);

  await hooks.afterDecrypt?.(state);
}
