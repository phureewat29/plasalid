import inquirer from "inquirer";
import ora from "ora";
import { TOOL_LABELS } from "../ai/tools/index.js";
import { pickThinking } from "../ai/thinking.js";
import type { ProgressCallback } from "../ai/agent.js";
import { formatDuration } from "./format.js";

/**
 * Minimal spinner interface so callers don't care whether we're animating in
 * a TTY or just printing plain lines. The same instance can be `pause()`d and
 * `resume()`d around an inquirer prompt to keep the terminal sane.
 */
export interface SpinnerLike {
  text: string;
  succeed(text?: string): void;
  fail(text?: string): void;
  info(text?: string): void;
  stop(): void;
  /** TTY: clear the spinner line (ora.stop). Non-TTY: no-op. */
  pause(): void;
  /** TTY: resume animation with the current `text`. Non-TTY: no-op. */
  resume(): void;
}

/**
 * One blank line above every spinner so output doesn't crowd whatever printed
 * before. TTY uses ora; non-TTY (cron, piped output) prints the leading text
 * once and turns succeed/fail/info into prefixed plain lines.
 */
export function statusSpinner(text: string): SpinnerLike {
  console.log("");
  if (process.stdout.isTTY) {
    const spinner = ora({ text }).start();
    return {
      get text() { return spinner.text; },
      set text(t: string) { spinner.text = t; },
      succeed: (t) => { spinner.succeed(t); },
      fail: (t) => { spinner.fail(t); },
      info: (t) => { spinner.info(t); },
      stop: () => { spinner.stop(); },
      pause: () => { spinner.stop(); },
      resume: () => { spinner.start(); },
    };
  }
  console.log(text);
  return {
    text,
    succeed: (t) => { if (t) console.log(`✓ ${t}`); },
    fail: (t) => { if (t) console.log(`✗ ${t}`); },
    info: (t) => { if (t) console.log(`• ${t}`); },
    stop: () => {},
    pause: () => {},
    resume: () => {},
  };
}

/**
 * Build an `ask_user`-style prompter bound to the active spinner. Pauses the
 * spinner around the inquirer call so it doesn't fight for the same terminal
 * line, pads with blank lines for readability, and always includes a free-text
 * escape on choice prompts ("Type a different answer…").
 */
export function makePromptUser(
  spinner: SpinnerLike,
): (prompt: string, options?: string[]) => Promise<string> {
  const OTHER = "__plasalid_other__";
  return async (prompt, options) => {
    spinner.pause();
    console.log("");
    try {
      if (options && options.length > 0) {
        const choices = [
          // A blank-ish separator gives breathing room between the question
          // line and the first choice — inquirer renders separators inline,
          // and rejects truly-empty strings, so we use a single space.
          new inquirer.Separator(" "),
          ...options.map(o => ({ name: o, value: o })),
          new inquirer.Separator(),
          { name: "Type a different answer…", value: OTHER },
        ];
        const { choice } = await inquirer.prompt([
          { type: "list", name: "choice", message: prompt, choices },
        ]);
        if (choice === OTHER) {
          const { freeform } = await inquirer.prompt([
            { type: "input", name: "freeform", message: "Your answer:" },
          ]);
          return String(freeform).trim();
        }
        return String(choice);
      }
      const { answer } = await inquirer.prompt([
        { type: "input", name: "answer", message: prompt },
      ]);
      return String(answer);
    } finally {
      console.log("");
      spinner.resume();
    }
  };
}

/**
 * Standard agent-progress → spinner-text bridge.
 * - `phase: "tool"` maps the tool name through `TOOL_LABELS`.
 * - `phase: "responding"` picks a stable thinking phrase per session and shows
 *   the elapsed time + tool count.
 * Optional `subject` (e.g. a file name) is appended in parentheses.
 */
export function makeAgentOnProgress(
  spinner: SpinnerLike,
  subject?: string,
): ProgressCallback {
  const idlePhrase = pickThinking();
  const subjectPart = subject ? ` (${subject})` : "";
  return ({ phase, toolName, toolCount, elapsedMs }) => {
    const elapsed = formatDuration(elapsedMs);
    const suffix = toolCount > 0 ? ` (${toolCount} tool${toolCount === 1 ? "" : "s"}, ${elapsed})` : "";
    if (phase === "tool" && toolName) {
      spinner.text = `${TOOL_LABELS[toolName] ?? toolName}${suffix}`;
    } else {
      spinner.text = `${idlePhrase}${subjectPart}${suffix}`;
    }
  };
}
