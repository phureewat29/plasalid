/**
 * Defensive helpers for interpolating user / model-controlled text into
 * tool-output strings that flow back to the LLM. They strip control characters
 * that could smuggle instructions across data/instruction boundaries.
 */

/** Strip control characters (newlines, tabs, ANSI escapes) from text. */
export function stripControls(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1F\x7F]/g, " ").trim();
}

/** Sanitize text for prompt interpolation (no length clip — keep full content). */
export function sanitizeForPrompt(text: string | null | undefined): string {
  if (!text) return "";
  return stripControls(text);
}

/**
 * Sanitize for use inside a `|`-delimited row. Replaces literal `|` characters
 * with `/` so a memo / account name containing `|` can't spoof extra columns.
 */
export function sanitizeForPromptCell(text: string | null | undefined): string {
  if (!text) return "";
  return stripControls(text).replace(/\|/g, "/");
}
