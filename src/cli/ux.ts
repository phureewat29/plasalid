import inquirer from "inquirer";
import ora from "ora";
import chalk from "chalk";
import { TOOL_LABELS } from "../ai/tools/index.js";
import { pickThinking } from "../ai/thinking.js";
import type { ProgressCallback } from "../ai/agent.js";
import type { PromptUserFacts } from "../ai/tools/types.js";
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
 * before. TTY uses ora; non-TTY (cron, piped output) prints lines as it goes.
 */
export function statusSpinner(text: string): SpinnerLike {
  console.log("");
  return process.stdout.isTTY ? oraSpinner(text) : plainSpinner(text);
}

function oraSpinner(text: string): SpinnerLike {
  const s = ora({ text }).start();
  return {
    get text() {
      return s.text;
    },
    set text(t: string) {
      s.text = t;
    },
    succeed: (t) => {
      s.succeed(t);
    },
    fail: (t) => {
      s.fail(t);
    },
    info: (t) => {
      s.info(t);
    },
    stop: () => {
      s.stop();
    },
    pause: () => {
      s.stop();
    },
    resume: () => {
      s.start();
    },
  };
}

function plainSpinner(initial: string): SpinnerLike {
  console.log(initial);
  return {
    text: initial,
    succeed: (t) => {
      if (t) console.log(`✓ ${t}`);
    },
    fail: (t) => {
      if (t) console.log(`✗ ${t}`);
    },
    info: (t) => {
      if (t) console.log(`• ${t}`);
    },
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
): (
  prompt: string,
  options?: string[],
  facts?: PromptUserFacts,
) => Promise<string> {
  return async (prompt, options, facts) => {
    spinner.pause();
    console.log("");
    printFacts(facts);
    try {
      return options?.length
        ? await askList(prompt, options)
        : await askInput(prompt);
    } finally {
      console.log("");
      spinner.resume();
    }
  };
}

function printFacts(facts?: PromptUserFacts): void {
  const line = facts ? formatFacts(facts) : null;
  if (line) console.log(line);
}

const OTHER_SENTINEL = "__plasalid_other__";

async function askList(prompt: string, options: string[]): Promise<string> {
  const choices = [
    new inquirer.Separator(" "),
    ...options.map((o) => ({ name: o, value: o })),
    new inquirer.Separator(),
    { name: "Type a different answer…", value: OTHER_SENTINEL },
  ];
  const { choice } = await inquirer.prompt([
    {
      type: "list",
      name: "choice",
      message: prompt,
      choices,
      loop: false,
      pageSize: Math.max(choices.length, 10),
    },
  ]);
  return choice === OTHER_SENTINEL
    ? await askInput("Your answer:")
    : String(choice);
}

async function askInput(prompt: string): Promise<string> {
  const { answer } = await inquirer.prompt([
    { type: "input", name: "answer", message: prompt },
  ]);
  return String(answer).trim();
}

/**
 * Standard agent-progress → spinner-text bridge.
 * - `tool` maps the tool name through `TOOL_LABELS`.
 * - `responding` picks a stable thinking phrase per session and shows the
 *   elapsed time + tool count.
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

/**
 * Render the structured facts the resolve agent attaches to ask_user as a
 * single colored line above the inquirer prompt. Each category has a fixed
 * chalk color so the user's eye picks out the type without reading prose.
 * Returns null when there's nothing to render (so the caller can skip the
 * blank line entirely).
 */
function formatFacts(f: PromptUserFacts): string | null {
  const parts: string[] = [];
  if (f.amount) parts.push(chalk.yellow(f.amount));
  if (f.date) parts.push(chalk.cyan(f.date));
  if (f.merchant) parts.push(chalk.green(f.merchant));
  for (const a of f.accounts ?? []) parts.push(chalk.magenta(a));
  return parts.length ? parts.join(chalk.dim(" · ")) : null;
}
