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
 * Count visible terminal cells. Each code point counts as 1, except Unicode
 * combining marks (\p{M}) which stack on the preceding base char and count
 * as 0. Does not handle East-Asian wide characters; revisit if CJK filenames
 * appear in real ledgers.
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const c of s) if (!/^\p{M}$/u.test(c)) w++;
  return w;
}

/**
 * Right-pad to a fixed visible width. Assumes `s` has no ANSI codes — callers
 * working with colored strings should compose color around the padded value,
 * not inside it. Pads by display width so Thai (and other scripts with
 * combining marks) stay aligned with surrounding columns.
 */
export function padRight(s: string, width: number): string {
  const visual = displayWidth(s);
  return visual >= width ? s : s + " ".repeat(width - visual);
}
