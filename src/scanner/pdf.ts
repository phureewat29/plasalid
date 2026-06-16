import { readFileSync, statSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { basename, extname } from "path";
import inquirer from "inquirer";
import type Database from "libsql";
import { config } from "../config.js";
import { statusSpinner } from "../cli/ux.js";
import { encryptSecret, decryptSecret } from "../db/encryption.js";
import type { DocumentBlock, ImageBlock, Provider } from "../ai/provider.js";
import type { Chunk, DecryptedFile } from "./engine.js";
import { errorMessage } from "../lib/result.js";

type Mupdf = typeof import("mupdf");
let mupdfPromise: Promise<Mupdf> | null = null;

// Lazy: WASM module isn't loaded until first call.
function getMupdf(): Promise<Mupdf> {
  if (!mupdfPromise) mupdfPromise = import("mupdf");
  return mupdfPromise;
}

// mupdf's authenticatePassword returns 0 on a wrong password, non-zero on success.
const MUPDF_AUTH_FAILED = 0;

export interface UnlockResult {
  ok: boolean;
  decrypted?: Buffer;
}

export async function isEncrypted(bytes: Buffer): Promise<boolean> {
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    return doc.needsPassword();
  } finally {
    doc.destroy();
  }
}

export async function unlock(
  bytes: Buffer,
  password: string,
): Promise<UnlockResult> {
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    if (!(doc instanceof mupdf.PDFDocument)) {
      return { ok: false };
    }
    if (!doc.needsPassword()) {
      return { ok: true, decrypted: bytes };
    }
    const result = doc.authenticatePassword(password);
    if (result === MUPDF_AUTH_FAILED) {
      return { ok: false };
    }
    const out = doc.saveToBuffer("decrypt");
    return { ok: true, decrypted: Buffer.from(out.asUint8Array()) };
  } finally {
    doc.destroy();
  }
}

/**
 * Password store: filename-pattern keyed, encrypted-at-rest
 */

export interface StoredPassword {
  id: string;
  pattern: string;
  password: string; // decrypted in-memory
  useCount: number;
  lastUsedAt: string | null;
}

interface PasswordRow {
  id: string;
  pattern: string;
  password_encrypted: string;
  use_count: number;
  last_used_at: string | null;
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
const SEPARATORS = /[_\-\s.]/;
const MIN_PREFIX_LEN = 3;

// Short or non-alpha prefixes fall back to escaped+digit-collapse to avoid `^a.*`-style false positives.
export function suggestPattern(filename: string): string {
  const name = basename(filename).toLowerCase();
  const prefix = name.split(SEPARATORS)[0];

  if (prefix.length >= MIN_PREFIX_LEN && /^[a-z]/.test(prefix)) {
    return `^${prefix.replace(REGEX_META, "\\$&")}.*`;
  }

  const escaped = name.replace(REGEX_META, "\\$&");
  const collapsed = escaped.replace(/\d+/g, "\\d+");
  return `^${collapsed}$`;
}

export function findCandidates(
  db: Database.Database,
  filePath: string,
  dbKey: string,
): StoredPassword[] {
  const target = basename(filePath);
  const rows = db
    .prepare(
      `SELECT id, pattern, password_encrypted, use_count, last_used_at
       FROM file_passwords
       ORDER BY use_count DESC, last_used_at DESC NULLS LAST, created_at ASC`,
    )
    .all() as PasswordRow[];
  return rows
    .filter((r) => safeTest(r.pattern, target))
    .map((r) => ({
      id: r.id,
      pattern: r.pattern,
      password: decryptSecret(r.password_encrypted, dbKey),
      useCount: r.use_count,
      lastUsedAt: r.last_used_at,
    }));
}

function safeTest(pattern: string, target: string): boolean {
  try {
    return new RegExp(pattern, "i").test(target);
  } catch {
    return false;
  }
}

// Replaces on conflict so a bank's rotated password overwrites the stale one.
export function savePassword(
  db: Database.Database,
  pattern: string,
  password: string,
  dbKey: string,
): string {
  const encrypted = encryptSecret(password, dbKey);
  const existing = db
    .prepare(`SELECT id FROM file_passwords WHERE pattern = ?`)
    .get(pattern) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE file_passwords
       SET password_encrypted = ?, use_count = 0, last_used_at = NULL
       WHERE id = ?`,
    ).run(encrypted, existing.id);
    return existing.id;
  }
  const id = `fp:${randomUUID()}`;
  db.prepare(
    `INSERT INTO file_passwords (id, pattern, password_encrypted) VALUES (?, ?, ?)`,
  ).run(id, pattern, encrypted);
  return id;
}

export function recordUse(db: Database.Database, id: string): void {
  db.prepare(
    `UPDATE file_passwords
     SET use_count = use_count + 1, last_used_at = datetime('now')
     WHERE id = ?`,
  ).run(id);
}

/**
 * Unlock orchestrator: probe → try stored → prompt-until-unlocked
 */

export type UnlockOutcome =
  | { kind: "plaintext" }
  | { kind: "from-store"; storedId: string }
  | { kind: "from-user"; password: string };

export interface UnlockCtx {
  db: Database.Database;
  filePath: string;
  bytes: Buffer;
  interactive: boolean;
}

export async function unlockIfNeeded(
  ctx: UnlockCtx,
): Promise<{ decrypted: Buffer; outcome: UnlockOutcome }> {
  const fileName = basename(ctx.filePath);
  const probe = statusSpinner(`Inspecting ${fileName}...`);
  let encrypted: boolean;
  try {
    encrypted = await isEncrypted(ctx.bytes);
  } catch (err) {
    probe.fail("Inspection failed.");
    throw err;
  }
  if (!encrypted) {
    probe.succeed(`${fileName} is not encrypted.`);
    return { decrypted: ctx.bytes, outcome: { kind: "plaintext" } };
  }

  const candidates = findCandidates(ctx.db, ctx.filePath, config.dbEncryptionKey);
  probe.info(
    `${fileName} is encrypted (${candidates.length} saved password${candidates.length === 1 ? "" : "s"} match).`,
  );

  const stored = await tryStored(ctx.bytes, candidates);
  if (stored) return stored;

  if (!ctx.interactive) throw new Error("password required");
  return await askUntilUnlocked(ctx.bytes, fileName);
}

async function tryStored(
  bytes: Buffer,
  candidates: StoredPassword[],
): Promise<{ decrypted: Buffer; outcome: UnlockOutcome } | null> {
  if (candidates.length === 0) return null;
  const spinner = statusSpinner(`Trying saved password 1/${candidates.length}...`);
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    spinner.text = `Trying saved password ${i + 1}/${candidates.length} (pattern ${cand.pattern})`;
    const result = await unlock(bytes, cand.password);
    if (result.ok && result.decrypted) {
      spinner.succeed(`Unlocked with saved password (pattern ${cand.pattern}).`);
      return {
        decrypted: result.decrypted,
        outcome: { kind: "from-store", storedId: cand.id },
      };
    }
  }
  spinner.info("No saved password matched. Asking the user.");
  return null;
}

async function askUntilUnlocked(
  bytes: Buffer,
  fileName: string,
): Promise<{ decrypted: Buffer; outcome: UnlockOutcome }> {
  let hasRetried = false;
  while (true) {
    const message = hasRetried
      ? `Wrong password. Try again for ${fileName}:`
      : `This PDF is encrypted. Password for ${fileName}:`;
    const { password } = await inquirer.prompt([
      { type: "password", name: "password", mask: "*", message },
    ]);
    const trimmed = String(password ?? "").trim();
    if (!trimmed) throw new Error("password required");

    const spinner = statusSpinner("Decrypting...");
    const result = await unlock(bytes, trimmed);
    if (result.ok && result.decrypted) {
      spinner.succeed("Decrypted.");
      return {
        decrypted: result.decrypted,
        outcome: { kind: "from-user", password: trimmed },
      };
    }
    spinner.fail("Incorrect password.");
    hasRetried = true;
  }
}

type OutcomeHandler = {
  [K in UnlockOutcome["kind"]]: (
    db: Database.Database,
    filePath: string,
    outcome: Extract<UnlockOutcome, { kind: K }>,
  ) => void;
};

const PERSIST: OutcomeHandler = {
  plaintext: () => {},
  "from-store": (db, _filePath, o) => {
    recordUse(db, o.storedId);
  },
  "from-user": (db, filePath, o) => {
    const pattern = suggestPattern(filePath);
    const spinner = statusSpinner(`Saving password for pattern ${pattern}...`);
    try {
      savePassword(db, pattern, o.password, config.dbEncryptionKey);
      spinner.succeed(`Saved password for pattern ${pattern} in secure vault.`);
    } catch (err: unknown) {
      spinner.fail(`Could not save password: ${errorMessage(err)}`);
      throw err;
    }
  },
};

export function persistUnlockOutcome(
  db: Database.Database,
  filePath: string,
  outcome: UnlockOutcome,
): void {
  (
    PERSIST[outcome.kind] as (
      db: Database.Database,
      filePath: string,
      o: UnlockOutcome,
    ) => void
  )(db, filePath, outcome);
}

/**
 * PDF read + hash + scan-attachment builders
 */

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
};

const MAX_BYTES = 30 * 1024 * 1024;

export interface LoadedFile {
  bytes: Buffer;
  hash: string;
  mime: string;
  fileName: string;
}

// Hash is sha256 of the on-disk bytes (still encrypted if pw-protected) so re-scans dedup before unlock.
export function readPdf(path: string): LoadedFile {
  const ext = extname(path).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(
      `Unsupported file extension: ${ext}. Plasalid v1 only ingests PDFs.`,
    );
  }
  const stat = statSync(path);
  if (stat.size > MAX_BYTES) {
    throw new Error(
      `File too large (${stat.size} bytes). Limit is ${MAX_BYTES} bytes.`,
    );
  }
  const bytes = readFileSync(path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { bytes, hash, mime, fileName: basename(path) };
}

export function buildDocumentBlock(
  bytes: Buffer,
  fileName: string,
  mime = "application/pdf",
): DocumentBlock {
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: mime,
      data: bytes.toString("base64"),
    },
    title: fileName,
  };
}

export async function buildScanAttachment(
  chunk: Chunk,
  provider: Provider,
): Promise<DocumentBlock | ImageBlock> {
  if (provider.acceptsDocuments) {
    return buildDocumentBlock(chunk.bytes, chunk.fileName, chunk.mime);
  }
  const { bytes, mime } = await rasterizePage(chunk.bytes);
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mime,
      data: bytes.toString("base64"),
    },
  };
}

/**
 * Page rasterize: PDF → PNG for VL providers that don't accept documents
 */

// Readable to a VL model without blowing up the token bill on a dense statement.
const DEFAULT_DPI = 150;

export async function rasterizePage(
  pdfBytes: Buffer,
  opts: { dpi?: number } = {},
): Promise<{ bytes: Buffer; mime: "image/png" }> {
  const mupdf = await getMupdf();
  const dpi = opts.dpi ?? DEFAULT_DPI;
  const scale = dpi / 72;

  const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
  try {
    const page = doc.loadPage(0);
    try {
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
      );
      try {
        const png = pixmap.asPNG();
        return { bytes: Buffer.from(png), mime: "image/png" };
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

/**
 * Page chunker: split one decrypted PDF into N single-page Chunks
 */

// mupdf lacks page-range extract; clone and delete other pages back-to-front so indices stay stable.
async function extractPage(
  file: DecryptedFile,
  pageIndex: number,
  pageCount: number,
): Promise<Chunk> {
  const mupdf = await getMupdf();
  const clone = mupdf.Document.openDocument(
    file.decryptedBytes,
    file.mime,
  ) as InstanceType<Mupdf["PDFDocument"]>;
  try {
    for (let j = pageCount - 1; j >= 0; j--) {
      if (j !== pageIndex) clone.deletePage(j);
    }
    const out = clone.saveToBuffer("decrypt");
    return {
      chunkId: `${file.path}#p${pageIndex + 1}`,
      fileId: file.path,
      fileName: file.fileName,
      relPath: file.relPath,
      pageNumber: pageIndex + 1,
      totalPages: pageCount,
      bytes: Buffer.from(out.asUint8Array()),
      mime: file.mime,
    };
  } finally {
    clone.destroy();
  }
}

export async function chunkPdf(file: DecryptedFile): Promise<Chunk[]> {
  const mupdf = await getMupdf();
  const probe = mupdf.Document.openDocument(file.decryptedBytes, file.mime);
  let pageCount: number;
  try {
    pageCount = probe.countPages();
  } finally {
    probe.destroy();
  }
  if (pageCount <= 0) return [];

  const chunks: Chunk[] = [];
  for (let i = 0; i < pageCount; i++) {
    chunks.push(await extractPage(file, i, pageCount));
  }
  return chunks;
}
