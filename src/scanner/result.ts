/**
 * Lightweight Result helpers shared across scanner subdomains. Use this
 * instead of inline try/catch when a function can fail with a human-readable
 * reason and the caller needs to branch on the outcome (decrypt, chunk parse,
 * commit-one-transaction). Distinct from concurrency.ts `Settled<T>` — that
 * type is owned by `runWithConcurrency` and includes an `error: unknown`;
 * `Result<T>` stringifies the error up front for ergonomic message handling.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function tryExecute<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
