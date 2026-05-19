import type Database from "libsql";
import { randomUUID } from "crypto";
import {
  insertTransactionRows,
  validateTransaction,
  type TransactionInput,
} from "../db/queries/transactions.js";
import { recordConcern } from "../db/queries/concerns.js";

/**
 * One scan agent's pending writes. Transactions and concerns accumulate here
 * while the LLM works; nothing hits the DB until `commit()` runs inside a
 * single SQLite transaction. If `commit()` throws, the transaction rolls back
 * and the DB stays exactly as it was before this file's scan began.
 *
 * Account writes (`create_account`, `update_account_metadata`) and merchant
 * writes deliberately bypass the buffer — they go directly to the DB through
 * their own mutexes so concurrent agents see each other's creates and don't
 * duplicate.
 */
export interface BufferedConcern {
  /** Synthesized when the LLM called note_concern with a buffered transaction_id. */
  transaction_id: string | null;
  account_id: string | null;
  kind?: string | null;
  prompt: string;
  options?: string[];
}

export interface BufferedTransaction {
  /** Synthesized at queue-time so concerns can reference this transaction. */
  transaction_id: string;
  input: TransactionInput;
}

export class BufferedWriteContext {
  readonly fileName: string;
  readonly transactions: BufferedTransaction[] = [];
  readonly concerns: BufferedConcern[] = [];
  doneSummary: string | null = null;

  constructor(fileName: string) {
    this.fileName = fileName;
  }

  /**
   * Queue a transaction. Returns the synthesized transaction id so the agent
   * can use it in subsequent note_concern calls inside the same file.
   */
  appendTransaction(input: TransactionInput): string {
    const transactionId = `tx:${randomUUID()}`;
    this.transactions.push({ transaction_id: transactionId, input });
    return transactionId;
  }

  appendConcern(concern: BufferedConcern): void {
    this.concerns.push(concern);
  }

  markDone(summary: string): void {
    this.doneSummary = summary;
  }

  get isDone(): boolean {
    return this.doneSummary !== null;
  }

  /**
   * Replay all buffered writes inside one DB transaction. `scannedFileId` is
   * stamped onto every transaction and concern so they're attributable to this
   * file. Returns `{ transactions, concerns }` counts so the caller can report
   * them.
   */
  commit(db: Database.Database, scannedFileId: string): { transactions: number; concerns: number } {
    const validated = this.transactions.map(b => ({
      buffered: b,
      validated: validateTransaction({
        ...b.input,
        id: b.transaction_id,
        source_file_id: scannedFileId,
      }),
    }));

    const tx = db.transaction(() => {
      for (const { validated: v } of validated) {
        insertTransactionRows(db, v);
      }
      for (const c of this.concerns) {
        recordConcern(db, {
          file_id: scannedFileId,
          transaction_id: c.transaction_id,
          account_id: c.account_id,
          kind: c.kind ?? null,
          prompt: c.prompt,
          options: c.options,
        });
      }
    });
    tx();
    return { transactions: this.transactions.length, concerns: this.concerns.length };
  }
}
