/**
 * Process-wide serialization for write operations that race when multiple scan
 * agents run in parallel. Each in-flight `create_account` / `update_account_metadata`
 * is held inside `runExclusive` so the SQLite write + the subsequent read-back
 * by another agent's `list_accounts` are consistent.
 *
 * Single tail-promise queue: cheap, deterministic, no extra deps.
 */
let tail: Promise<unknown> = Promise.resolve();

export function runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = tail.then(() => fn());
  // Swallow rejection so a thrown callback doesn't poison the queue for the
  // next caller. The caller still sees the rejection through `next`.
  tail = next.catch(() => undefined);
  return next;
}
