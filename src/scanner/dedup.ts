import type Database from "libsql";
import {
  deleteTransaction,
  findDuplicateTransactions,
  type DuplicateGroupTransaction,
} from "../db/queries/transactions.js";

/**
 * Deterministic strict-duplicate merge, decoupled from ScanState/hooks.
 * Copied from clarify.ts: within a duplicate group, keep the earliest
 * transaction and delete any later member that matches it exactly on
 * merchant, source file, date, and integer-cents amount.
 */
export function autoMergeStrictDuplicates(db: Database.Database): {
  merged: number;
} {
  let merged = 0;
  for (const group of findDuplicateTransactions(db)) {
    merged += autoMergeStrictGroup(db, group);
  }
  return { merged };
}

function autoMergeStrictGroup(
  db: Database.Database,
  group: DuplicateGroupTransaction[],
): number {
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
      Math.round(cand.amount * 100) === Math.round(head.amount * 100)
    ) {
      deleteTransaction(db, cand.id);
      deleted++;
    }
  }
  return deleted;
}
