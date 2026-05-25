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
