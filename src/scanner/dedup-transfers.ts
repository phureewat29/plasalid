import type Database from "libsql";
import {
  deleteTransfer,
  findDuplicateTransfers,
  type DuplicateTransferRow,
} from "../db/queries/transfers.js";

/**
 * Deterministic strict-duplicate merge for the transfer model, the counterpart
 * of `dedup.ts`'s `autoMergeStrictDuplicates`. Within each duplicate group,
 * keep the earliest transfer and delete any later member that matches it
 * exactly on merchant, source file, date, and amount. Amounts are integer minor
 * units, so equality is a plain `===` (no float rounding). The group finder
 * already excludes intra-group members, so linked legs are never merged away.
 */
export function autoMergeStrictDuplicateTransfers(db: Database.Database): { merged: number } {
  let merged = 0;
  for (const group of findDuplicateTransfers(db)) {
    merged += autoMergeStrictGroup(db, group);
  }
  return { merged };
}

function autoMergeStrictGroup(db: Database.Database, group: DuplicateTransferRow[]): number {
  const sorted = [...group].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  const head = sorted[0];
  if (!head.merchant_id || !head.source_file_id) return 0;

  let deleted = 0;
  for (let i = 1; i < sorted.length; i++) {
    const cand = sorted[i];
    if (
      cand.merchant_id === head.merchant_id &&
      cand.source_file_id === head.source_file_id &&
      cand.date === head.date &&
      cand.amount === head.amount
    ) {
      deleteTransfer(db, cand.id);
      deleted++;
    }
  }
  return deleted;
}
