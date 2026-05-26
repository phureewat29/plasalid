import { tryExecute, type Result } from "../lib/result.js";

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  n: number,
  signal?: AbortSignal,
): Promise<Result<T>[]> {
  const results: Result<T>[] = new Array(tasks.length);
  const workerCount = Math.max(1, Math.min(n, tasks.length));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      if (signal?.aborted) return;
      const index = cursor++;
      results[index] = await tryExecute(() => tasks[index]());
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
