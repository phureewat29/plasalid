export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

export class ApiAuthError extends Error {
  constructor(public readonly status: number) {
    super(`auth ${status}`);
    this.name = "ApiAuthError";
  }
}

export class RateLimitError extends Error {
  readonly status = 429;
  constructor() {
    super("rate limited");
    this.name = "RateLimitError";
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ProviderError = { status?: number; name?: string; message?: string };

export function classifyProviderError(err: unknown, signal?: AbortSignal): never {
  if (
    err instanceof AbortedError ||
    err instanceof ApiAuthError ||
    err instanceof RateLimitError ||
    err instanceof ApiError
  ) {
    throw err;
  }
  const e = (err ?? {}) as ProviderError;
  if (signal?.aborted || e.name === "AbortError") throw new AbortedError();
  if (e.status === 401 || e.status === 403) throw new ApiAuthError(e.status);
  if (e.status === 429) throw new RateLimitError();
  if (typeof e.status === "number") throw new ApiError(e.status, e.message ?? "");
  throw new ApiError(undefined, e.message ?? "internal error");
}
