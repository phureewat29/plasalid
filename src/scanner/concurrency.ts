/**
 * Run an array of async task factories with a fixed concurrency bound. Resolves
 * to a `Settled<T>[]` in the same order as the input tasks. One task throwing
 * never aborts the rest — its slot settles as `{ ok: false, error }` and the
 * caller decides what to do.
 *
 * No new dependency. Simple worker-pool: kicks off up to `n` tasks, then each
 * worker pulls the next index from a shared cursor until the queue is drained.
 */
export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  n: number,
): Promise<Settled<T>[]> {
  const results: Settled<T>[] = new Array(tasks.length);
  const workerCount = Math.max(1, Math.min(n, tasks.length));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const index = cursor++;
      try {
        results[index] = { ok: true, value: await tasks[index]() };
      } catch (err) {
        results[index] = { ok: false, error: err };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
