/** Today's date as an ISO calendar date (YYYY-MM-DD), UTC. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
