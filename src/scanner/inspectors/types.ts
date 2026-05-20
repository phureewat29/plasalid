import type Database from "libsql";
import type { RecordUnknownInput } from "../../db/queries/unknowns.js";

/**
 * Scope passed to every inspector by the scanner's Phase 5. Inspectors emit
 * unknowns for transactions whose `source_file_id` is in `fileIds` (or for
 * cross-pair findings where at least one side lives in that set). Inspectors
 * are free to read the wider DB for context — the scope is a filter for what
 * to surface, not a limit on what to read.
 */
export interface InspectorScope {
  readonly fileIds: readonly string[];
}

export interface Inspector {
  readonly name: string;
  inspect(db: Database.Database, scope: InspectorScope): RecordUnknownInput[];
}
