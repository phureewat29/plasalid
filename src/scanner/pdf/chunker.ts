import type { Chunk, DecryptedFile } from "../engine.js";

type Mupdf = typeof import("mupdf");
let mupdfPromise: Promise<Mupdf> | null = null;

function getMupdf(): Promise<Mupdf> {
  if (!mupdfPromise) mupdfPromise = import("mupdf");
  return mupdfPromise;
}

/**
 * Build one Chunk holding exactly page `pageIndex` of `file`. mupdf has no
 * native page-range extract, so we clone the source doc and delete every
 * other page, back-to-front so indices stay stable as we splice. Resource
 * lifetime is contained in the try/finally so a saveToBuffer failure can't
 * leak the cloned doc.
 */
async function extractPage(file: DecryptedFile, pageIndex: number, pageCount: number): Promise<Chunk> {
  const mupdf = await getMupdf();
  const clone = mupdf.Document.openDocument(file.decryptedBytes, file.mime) as InstanceType<Mupdf["PDFDocument"]>;
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

/**
 * Split one decrypted PDF into N single-page Chunks. Each chunk is a
 * standalone, valid PDF so the per-chunk LLM agent gets a clean document
 * without siblings.
 */
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
