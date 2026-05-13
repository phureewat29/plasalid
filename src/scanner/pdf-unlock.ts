/**
 * Thin wrapper around the mupdf WASM library. Lazy-imported on first call so
 * the WASM module isn't loaded for data dirs that contain only plaintext PDFs.
 */

type Mupdf = typeof import("mupdf");
let mupdfPromise: Promise<Mupdf> | null = null;

function getMupdf(): Promise<Mupdf> {
  if (!mupdfPromise) {
    mupdfPromise = import("mupdf");
  }
  return mupdfPromise;
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

export interface UnlockResult {
  ok: boolean;
  /** Set when `ok === true`. Plaintext (decrypted) PDF bytes ready to forward. */
  decrypted?: Buffer;
}

/**
 * Attempt to unlock and re-save `bytes` as an unencrypted PDF using `password`.
 * Returns `{ ok: false }` on wrong password or non-PDF input. Returns
 * `{ ok: true, decrypted }` on success. If the input wasn't encrypted to begin
 * with, returns `{ ok: true, decrypted: bytes }` unchanged.
 */
export async function unlock(bytes: Buffer, password: string): Promise<UnlockResult> {
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
    if (result === 0) {
      return { ok: false };
    }
    const out = doc.saveToBuffer("decrypt");
    return { ok: true, decrypted: Buffer.from(out.asUint8Array()) };
  } finally {
    doc.destroy();
  }
}
