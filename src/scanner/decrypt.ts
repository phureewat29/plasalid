import { randomUUID } from "crypto";
import { readdirSync, statSync } from "fs";
import { resolve, basename, relative, sep } from "path";
import type Database from "libsql";
import { getDataDir } from "../config.js";
import { readPdf, unlockIfNeeded, persistUnlockOutcome, type LoadedFile } from "./pdf.js";
import { tryExecute } from "../lib/result.js";
import type { DecryptedFile, ScanState } from "./engine.js";
import type { ScanHooks } from "./hooks.js";

export interface ScannedFile {
  path: string;
  name: string;
  // Forward-slashed relative path from the data dir.
  relPath: string;
}

const SUPPORTED_EXTS = new Set([".pdf"]);

function walk(dir: string, root: string, out: ScannedFile[]): void {
  const entries = tryExecute(() => readdirSync(dir));
  if (!entries.ok) return;

  for (const entry of entries.value) {
    if (entry.startsWith(".")) continue;
    const full = resolve(dir, entry);

    const stat = tryExecute(() => statSync(full));
    if (!stat.ok) continue;

    if (stat.value.isDirectory()) {
      walk(full, root, out);
      continue;
    }
    if (!stat.value.isFile()) continue;

    const ext = entry.slice(entry.lastIndexOf(".")).toLowerCase();
    if (!SUPPORTED_EXTS.has(ext)) continue;

    out.push({
      path: full,
      name: basename(full),
      relPath: relative(root, full).split(sep).join("/"),
    });
  }
}

export function scanDataDir(): ScannedFile[] {
  const out: ScannedFile[] = [];
  const root = getDataDir();
  walk(root, root, out);
  return out;
}

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

// Must run before parse so worker tools can stamp transactions.source_file_id.
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

// Sequential by design — password prompts can't share a TTY.
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
