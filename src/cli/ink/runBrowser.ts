import { render } from "ink";
import type { ReactElement } from "react";

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[?25l"; // enter alternate buffer, hide cursor
const LEAVE_ALT_SCREEN = "\x1b[?25h\x1b[?1049l"; // show cursor, leave alternate buffer

/**
 * Mount an Ink browser in the terminal's alternate-screen buffer so frame
 * swaps are atomic (no visible clear-and-rewrite cycle, no scrollback
 * pollution). Restores the original buffer on exit, error, or Ctrl-C.
 */
export async function runBrowser(node: ReactElement): Promise<void> {
  process.stdout.write(ENTER_ALT_SCREEN);

  const restore = (): void => { process.stdout.write(LEAVE_ALT_SCREEN); };
  const onSig = (): void => { restore(); process.exit(130); };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  try {
    const instance = render(node);
    await instance.waitUntilExit();
  } finally {
    process.removeListener("SIGINT", onSig);
    process.removeListener("SIGTERM", onSig);
    restore();
  }
}
