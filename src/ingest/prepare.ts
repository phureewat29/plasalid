import { randomUUID } from "crypto";
import {
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "fs";
import { isAbsolute, resolve, relative, sep } from "path";
import type Database from "libsql";
import { config, getDataDir, getCacheDir } from "../config.js";
import {
  readPdf,
  isEncrypted,
  unlockNonInteractive,
  rasterizePageN,
  countPdfPages,
  findCandidates,
} from "./pdf.js";
import { deleteFile, findFileById } from "../db/queries/files.js";
import { tryExecute } from "../lib/result.js";

type IngestStatus = "new" | "pending" | "ingested" | "failed";

interface IngestEntry {
  path: string;
  // Forward-slashed relative path from the data dir.
  relPath: string;
  hash: string;
  fileId: string | null;
  status: IngestStatus;
  encrypted: boolean;
  vaultCandidates: number;
}

interface PreparedPage {
  page: number;
  path: string;
}

export interface PrepareResult {
  fileId: string;
  pageCount: number;
  format: "png" | "pdf";
  /** Present for format:"pdf" — the document to Read directly (original path
   *  when unencrypted, a decrypted cache copy when the source was encrypted). */
  document?: string;
  pages: PreparedPage[];
}

/** Thrown when a PDF is encrypted and neither the vault nor the caller's
 *  password unlocks it; the CLI maps `reason` to its own exit/prompt behavior. */
export class PasswordRequiredError extends Error {
  readonly reason: "password_required" | "wrong_password";
  constructor(reason: "password_required" | "wrong_password") {
    super(
      reason === "wrong_password"
        ? "Incorrect password for encrypted PDF."
        : "Password required for encrypted PDF.",
    );
    this.name = "PasswordRequiredError";
    this.reason = reason;
  }
}

const SUPPORTED_EXTS = new Set([".pdf"]);

interface WalkedFile {
  path: string;
  relPath: string;
}

// Recursively walks the data dir for PDFs.
function walk(dir: string, root: string, out: WalkedFile[]): void {
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

    out.push({ path: full, relPath: relative(root, full).split(sep).join("/") });
  }
}

interface KnownRow {
  id: string;
  status: "pending" | "ingested" | "failed";
}

function findKnownByHash(db: Database.Database, hash: string): KnownRow | null {
  return (
    (db
      .prepare(`SELECT id, status FROM files WHERE file_hash = ?`)
      .get(hash) as KnownRow | undefined) ?? null
  );
}

export async function discoverFiles(
  db: Database.Database,
  opts: { regex?: RegExp } = {},
): Promise<IngestEntry[]> {
  const root = getDataDir();
  const walked: WalkedFile[] = [];
  walk(root, root, walked);

  const entries: IngestEntry[] = [];
  for (const file of walked) {
    if (opts.regex && !opts.regex.test(file.relPath)) continue;
    const loaded = readPdf(file.path);
    const known = findKnownByHash(db, loaded.hash);
    const encrypted = await isEncrypted(loaded.bytes);
    const vaultCandidates = encrypted
      ? findCandidates(db, file.path, config.dbEncryptionKey).length
      : 0;
    entries.push({
      path: file.path,
      relPath: file.relPath,
      hash: loaded.hash,
      fileId: known?.id ?? null,
      status: known ? known.status : "new",
      encrypted,
      vaultCandidates,
    });
  }
  return entries;
}

/** Pending row keyed by content hash, so re-registering the same bytes is a
 *  no-op that returns the existing id. */
export function registerPendingFile(
  db: Database.Database,
  absPath: string,
): { fileId: string; alreadyKnown: boolean } {
  const loaded = readPdf(absPath);
  const known = findKnownByHash(db, loaded.hash);
  if (known) return { fileId: known.id, alreadyKnown: true };

  const fileId = `sf:${randomUUID()}`;
  db.prepare(
    `INSERT INTO files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, 'pending')`,
  ).run(fileId, absPath, loaded.hash, loaded.mime);
  return { fileId, alreadyKnown: false };
}

interface PrepareOptions {
  password?: string;
  force?: boolean;
  format?: "png" | "pdf";
  dpi?: number;
  // 0-based page indices; omit for every page.
  pages?: number[];
  outDir?: string;
}

/**
 * Resolves the entry path in order: absolute, data-dir-relative (what `ingest
 * list`'s `rel_path` emits), cwd-relative, then `sf:` file id. Returns null
 * when nothing matches.
 */
export function resolveEntryPath(db: Database.Database, entryOrId: string): string | null {
  // 1. Absolute path that exists as-is.
  if (isAbsolute(entryOrId) && existsSync(entryOrId)) return entryOrId;

  // 2. Relative to the data dir — makes `rel_path` from `ingest list` work
  //    regardless of the caller's cwd.
  const viaDataDir = resolve(getDataDir(), entryOrId);
  if (existsSync(viaDataDir)) return viaDataDir;

  // 3. Relative to the current working directory (legacy behavior).
  const viaCwd = resolve(entryOrId);
  if (existsSync(viaCwd)) return viaCwd;

  // 4. A file id.
  const byId = findFileById(db, entryOrId);
  if (byId) return byId.path;

  return null;
}

export async function prepareFile(
  db: Database.Database,
  entryOrId: string,
  opts: PrepareOptions = {},
): Promise<PrepareResult> {
  const format = opts.format ?? "pdf";

  const absPath = resolveEntryPath(db, entryOrId);
  if (absPath === null) {
    throw new Error(`no ingest entry or file at "${entryOrId}"`);
  }

  const loaded = readPdf(absPath);
  let known = findKnownByHash(db, loaded.hash);
  if (known && opts.force) {
    deleteFile(db, known.id);
    known = null;
  }
  const fileId = known
    ? known.id
    : registerPendingFile(db, absPath).fileId;

  // Fast path: an unencrypted PDF is handed back by its original path — no cache copy, nothing written.
  if (format === "pdf" && !(await isEncrypted(loaded.bytes))) {
    const pageCount = await countPdfPages(loaded.bytes);
    return {
      fileId,
      pageCount,
      format,
      document: absPath,
      pages: [{ page: 0, path: absPath }],
    };
  }

  const unlocked = await unlockNonInteractive(db, loaded.bytes, absPath, {
    password: opts.password,
  });
  if (!unlocked.ok) throw new PasswordRequiredError(unlocked.reason);

  const pageCount = await countPdfPages(unlocked.decrypted);
  const outDir = opts.outDir ?? resolve(getCacheDir(), fileId);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });

  if (format === "pdf") {
    const out = resolve(outDir, "document.pdf");
    writeFileSync(out, unlocked.decrypted, { mode: 0o600 });
    return { fileId, pageCount, format, document: out, pages: [{ page: 0, path: out }] };
  }

  const requested = opts.pages ?? range(pageCount);
  const pages = await rasterizePages(unlocked.decrypted, requested, pageCount, outDir, opts.dpi);
  return { fileId, pageCount, format, pages };
}

async function rasterizePages(
  decrypted: Buffer,
  requested: number[],
  pageCount: number,
  outDir: string,
  dpi?: number,
): Promise<PreparedPage[]> {
  for (const p of requested) {
    if (p < 0 || p >= pageCount) {
      throw new Error(`page ${p} out of range (0..${pageCount - 1}).`);
    }
  }
  const pages: PreparedPage[] = [];
  for (const p of requested) {
    const png = await rasterizePageN(decrypted, p, dpi);
    const out = resolve(outDir, `p${p}.png`);
    writeFileSync(out, png, { mode: 0o600 });
    pages.push({ page: p, path: out });
  }
  return pages;
}

export function cleanCache(fileId?: string): { removed: string[] } {
  const base = getCacheDir();

  if (fileId) {
    const dir = resolve(base, fileId);
    if (!existsSync(dir)) return { removed: [] };
    rmSync(dir, { recursive: true, force: true });
    return { removed: [dir] };
  }

  if (!existsSync(base)) return { removed: [] };
  const removed = readdirSync(base).map((name) => resolve(base, name));
  rmSync(base, { recursive: true, force: true });
  return { removed };
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
