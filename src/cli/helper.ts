/**
 * Trim `s` to `max` characters, keeping the head and tail and inserting `…`
 * in the middle. Returns `s` unchanged when already short enough.
 */
export function truncateMiddle(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max < 5) return s.slice(0, max);
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/**
 * Right-pad to a fixed visible width. Assumes `s` has no ANSI codes — callers
 * working with colored strings should compose color around the padded value,
 * not inside it.
 */
export function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}
