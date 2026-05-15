/**
 * Run an array of async task factories with a fixed concurrency bound. Resolves
 * to an array of results in the same order as the input tasks (regardless of
 * completion order). Any rejection settles that slot with `undefined` and the
 * caller is responsible for tracking failures — but since each task is wrapped
 * in `Promise.resolve()` and pushed through `try/catch`, one task throwing
 * never aborts the rest of the run.
 *
 * No new dependency. Simple worker-pool: kicks off up to `n` tasks, then each
 * worker pulls the next index from a shared cursor until the queue is drained.
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  n: number,
): Promise<Array<T | { error: unknown }>> {
  const results: Array<T | { error: unknown }> = new Array(tasks.length);
  const workerCount = Math.max(1, Math.min(n, tasks.length));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= tasks.length) return;
      try {
        results[index] = await tasks[index]();
      } catch (err) {
        results[index] = { error: err };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
