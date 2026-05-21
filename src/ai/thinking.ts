/**
 * Idle/thinking phrases used by the chat hook and the scan spinner when the
 * AI is composing a response (no specific tool to label). Kept in one place so
 * both surfaces stay in sync.
 */
const THINKING_PHRASES = [
  "Thinking...",
  "Working through the numbers...",
  "Doing the math...",
  "Running the numbers...",
  "Crunching the numbers...",
  "Connecting the dots...",
  "Following the money...",
  "Reading between the lines...",
  "Putting the pieces together...",
  "Lining things up...",
  "Sifting through the details...",
  "Weighing it up...",
  "Tracing the trail...",
  "Cross-checking...",
  "Adding it up...",
  "Sorting through it...",
  "Considering the angles...",
  "Taking a closer look...",
  "Squaring things up...",
  "Tallying things up...",
  "Squinting at the numbers...",
  "Doing math, the slow kind...",
  "Computing... probably correctly...",
  "Pondering quietly...",
  "Joining the dots...",
  "Making sense of it...",
  "Sharpening the pencil...",
  "Catching up on the details...",
  "Comparing notes...",
  "Pulling the threads together...",
];

export function pickThinking(): string {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
}
