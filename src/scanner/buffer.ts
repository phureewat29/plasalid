import type Database from "libsql";
import { randomUUID } from "crypto";
import {
  insertJournalEntryRows,
  validateJournalEntry,
  type JournalEntryInput,
} from "../db/queries/journal.js";
import { recordConcern } from "../db/queries/concerns.js";

/**
 * One scan agent's pending writes. Journal entries and concerns accumulate
 * here while the LLM works; nothing hits the DB until `commit()` runs inside
 * a single SQLite transaction. If `commit()` throws, the transaction rolls
 * back and the DB stays exactly as it was before this file's scan began.
 *
 * Account writes (`create_account`, `update_account_metadata`) deliberately
 * bypass the buffer — they go directly to the DB through `account_mutex` so
 * concurrent agents see each other's account creations and don't duplicate.
 */
export interface BufferedConcern {
  /** Synthesized when the LLM called note_concern with a buffered entry_id. */
  entry_id: string | null;
  account_id: string | null;
  prompt: string;
  options?: string[];
}

export interface BufferedEntry {
  /** Synthesized at queue-time so concerns can reference this entry. */
  entry_id: string;
  input: JournalEntryInput;
}

export class BufferedWriteContext {
  readonly fileName: string;
  readonly journalEntries: BufferedEntry[] = [];
  readonly concerns: BufferedConcern[] = [];
  doneSummary: string | null = null;

  constructor(fileName: string) {
    this.fileName = fileName;
  }

  /**
   * Queue a journal entry. Returns the synthesized entry id so the agent can
   * use it in subsequent note_concern calls inside the same file.
   */
  appendEntry(input: JournalEntryInput): string {
    const entryId = `je:${randomUUID()}`;
    this.journalEntries.push({ entry_id: entryId, input });
    return entryId;
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
   * stamped onto every entry and concern so they're attributable to this file.
   * Returns `{ entries, concerns }` counts so the caller can report them.
   */
  commit(db: Database.Database, scannedFileId: string): { entries: number; concerns: number } {
    // Validate all entries up-front so a balance error throws before we open
    // the transaction (clean failure with no partial state to roll back).
    const validated = this.journalEntries.map(b => ({
      buffered: b,
      validated: validateJournalEntry({
        ...b.input,
        id: b.entry_id,
        source_file_id: scannedFileId,
      }),
    }));

    const tx = db.transaction(() => {
      for (const { validated: v } of validated) {
        insertJournalEntryRows(db, v);
      }
      for (const c of this.concerns) {
        recordConcern(db, {
          file_id: scannedFileId,
          entry_id: c.entry_id,
          account_id: c.account_id,
          prompt: c.prompt,
          options: c.options,
        });
      }
    });
    tx();
    return { entries: this.journalEntries.length, concerns: this.concerns.length };
  }
}
