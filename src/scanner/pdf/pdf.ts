import { readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import { basename, extname } from "path";
import type { DocumentBlock, ImageBlock, Provider } from "../../ai/provider.js";
import type { Chunk } from "../engine.js";
import { rasterizePage } from "./rasterize.js";

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

/**
 * Read a local PDF, hash its bytes, and return everything the scan pipeline
 * needs to decide whether to skip / re-scan / unlock the file. The hash is
 * sha256 of the original on-disk bytes (still encrypted if the PDF is
 * password-protected) — that's what the dedup contract relies on, so we can
 * recognize the same file across re-scans regardless of unlock state.
 */
export function readPdf(path: string): LoadedFile {
  const ext = extname(path).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(`Unsupported file extension: ${ext}. Plasalid v1 only ingests PDFs.`);
  }
  const stat = statSync(path);
  if (stat.size > MAX_BYTES) {
    throw new Error(`File too large (${stat.size} bytes). Limit is ${MAX_BYTES} bytes.`);
  }
  const bytes = readFileSync(path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { bytes, hash, mime, fileName: basename(path) };
}

export function buildDocumentBlock(bytes: Buffer, fileName: string, mime = "application/pdf"): DocumentBlock {
  return {
    type: "document",
    source: { type: "base64", media_type: mime, data: bytes.toString("base64") },
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
    source: { type: "base64", media_type: mime, data: bytes.toString("base64") },
  };
}
