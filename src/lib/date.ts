/** Today's date as an ISO calendar date (YYYY-MM-DD), UTC. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** ISO calendar date shape (YYYY-MM-DD). Shape only — no calendar validity check. */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
