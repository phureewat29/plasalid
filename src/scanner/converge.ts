/**
 * Drive a stateful loop toward convergence: keep running passes until the
 * caller's `isDone` predicate is true (success), `isStalled` returns true
 * across two passes (stall), or `maxAttempts` is exhausted (fail).
 *
 * The driver owns counting passes, stall detection, and the iteration cap.
 * Everything else (work per pass, callbacks per terminal state) lives in the
 * hooks the caller supplies. `S` is whatever quantity decides "are we done?".
 */
export interface ConvergeOpts<S> {
  /** Initial state (e.g. `countOpenUnknowns(db)`). */
  initial: S;
  /** Maximum number of passes before declaring failure. Must be >= 1. */
  maxAttempts: number;
  /** True when the work is finished and the loop should stop cleanly. */
  isDone: (state: S) => boolean;
  /**
   * True when this pass made no progress vs the previous pass. Fires after
   * the first pass at the earliest.
   */
  isStalled: (curr: S, prev: S) => boolean;
  /** Run one pass; return the new state. Pass numbers are 1-indexed. */
  onPass: (pass: number, state: S) => Promise<S>;
  onStart?: (state: S) => void;
  onStall?: (state: S) => void;
  onSuccess?: (state: S) => void;
  onFail?: (state: S) => void;
}

export async function converge<S>(opts: ConvergeOpts<S>): Promise<S> {
  let state = opts.initial;
  let prev = state;
  opts.onStart?.(state);

  for (let pass = 1; pass <= opts.maxAttempts && !opts.isDone(state); pass++) {
    if (pass > 1 && opts.isStalled(state, prev)) {
      opts.onStall?.(state);
      return state;
    }
    prev = state;
    state = await opts.onPass(pass, state);
  }

  (opts.isDone(state) ? opts.onSuccess : opts.onFail)?.(state);
  return state;
}
