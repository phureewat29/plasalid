import { createHash } from "crypto";

/**
 * Deterministic id from source coordinates so re-ingesting the same file is
 * idempotent: `tx:` + sha256("<hash>|<page>|<row>[|<leg>]"). Omitting `legIndex`
 * makes the hash match `deriveGroupId`'s.
 */
export function deriveTransactionId(
  fileHash: string,
  page: number,
  rowIndex: number,
  legIndex?: number,
): string {
  const base = `${fileHash}|${page}|${rowIndex}`;
  const material = legIndex != null ? `${base}|${legIndex}` : base;
  return "tx:" + createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** Deterministic group id for a source row: `tg:` + same hash as the legless
 *  `deriveTransactionId(fileHash, page, rowIndex)`. */
export function deriveGroupId(fileHash: string, page: number, rowIndex: number): string {
  return "tg:" + createHash("sha256").update(`${fileHash}|${page}|${rowIndex}`).digest("hex").slice(0, 16);
}
