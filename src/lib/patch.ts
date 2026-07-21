/** A single spec entry describing how one patch key maps onto a SQL column. */
export interface PatchField {
  /** SQL column; defaults to the patch key when omitted. */
  column?: string;
  /**
   * Normalize the incoming value before binding; the transformed value is
   * both the bound param and the audit `after` value.
   */
  transform?: (value: unknown) => unknown;
}

/**
 * Output of `buildPatch`: parallel `sets`/`params` arrays ready to splice
 * into an `UPDATE ... SET` statement, plus `before`/`after` audit snapshots
 * keyed by patch key (not by column).
 */
export interface PatchResult {
  sets: string[];
  params: unknown[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/**
 * Build the `SET` fragments, bound params, and before/after audit snapshots
 * for every `spec` key present in `patch`.
 *
 * A key participates only when `patch[key] !== undefined`; an absent key
 * leaves its column untouched, while an explicit `null` participates and
 * binds SQL NULL. `column` defaults to the key itself. `before[key]` reads
 * the column off `current` untouched; when `transform` is given, its return
 * value is used for both the bound param and `after[key]`.
 *
 * Deliberately has no `changed` flag: callers append any exceptional
 * hand-written fields to the returned arrays/objects, then test
 * `sets.length` themselves to decide whether anything actually changed.
 */
export function buildPatch<Row extends object>(
  spec: Record<string, PatchField>,
  current: Row,
  patch: object,
): PatchResult {
  const currentRecord = current as Record<string, unknown>;
  const patchRecord = patch as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  for (const key of Object.keys(spec)) {
    if (patchRecord[key] === undefined) continue;
    const field = spec[key];
    const column = field.column ?? key;
    const value = field.transform ? field.transform(patchRecord[key]) : patchRecord[key];

    sets.push(`${column} = ?`);
    // libsql cannot bind `undefined`; a transform should never produce one,
    // but this keeps the "params never contain undefined" contract airtight.
    params.push(value === undefined ? null : value);
    before[key] = currentRecord[column];
    after[key] = value;
  }

  return { sets, params, before, after };
}
