/**
 * Idle/thinking phrases used by the chat hook and the scan spinner when the
 * AI is composing a response (no specific tool to label). Kept in one place so
 * both surfaces stay in sync.
 */
export const THINKING_PHRASES = [
  "Thinking...",
  "Looking through your journal...",
  "Checking your accounts...",
  "Crunching the numbers...",
  "Pulling up your data...",
];

export function pickThinking(): string {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
}
