import chalk from "chalk";

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 1) return "< 1s";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const ERROR_MAP: Record<string, { msg: string; action: string }> = {
  "401": {
    msg: "Invalid API key.",
    action: "Run `plasalid setup` to reconfigure.",
  },
  "403": {
    msg: "API key rejected.",
    action: "Run `plasalid setup` to reconfigure.",
  },
  "429": { msg: "Rate limited.", action: "Wait a moment and try again." },
  network: {
    msg: "Could not reach the AI provider.",
    action: "Check your internet connection.",
  },
  decrypt: {
    msg: "Could not decrypt your data.",
    action: "Check your encryption key in `plasalid setup`.",
  },
};

export function formatError(error: any, context?: string): string {
  let key = "unknown";
  if (error?.status) key = String(error.status);
  else if (
    error?.code === "ENOTFOUND" ||
    error?.code === "ECONNREFUSED" ||
    error?.code === "ETIMEDOUT"
  )
    key = "network";
  else if (error?.message?.toLowerCase?.().includes("decrypt")) key = "decrypt";
  const mapped = ERROR_MAP[key];
  if (mapped) {
    return `${chalk.red("✗")} ${mapped.msg} ${chalk.dim(mapped.action)}`;
  }
  const safeMsg = error?.message || "Something went wrong.";
  return `${chalk.red("✗")} ${context ? context + ": " : ""}${safeMsg}`;
}

export function banner(): string {
  return chalk.bold("Plasalid") + chalk.dim("  ·  Talk to your money");
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function box(label: string, lines: string[]): string {
  const cols = process.stdout.columns || 100;
  const inner = cols - 4;
  const top = `┌─── ${label} ${"─".repeat(Math.max(0, inner - label.length - 5))}┐`;
  const bot = `└${"─".repeat(inner + 2)}┘`;
  const pad = `│${" ".repeat(inner + 2)}│`;
  const body = lines.map((l) => {
    const vis = stripAnsi(l).length;
    return `│  ${l}${" ".repeat(Math.max(0, inner - vis))}│`;
  });
  return [top, pad, ...body, pad, bot].join("\n");
}

const DISCLAIMER =
  "Plasalid is an assistant, not a financial advisor. It only summarizes financial statements — verify amounts against your statements before relying on them.";

export function helpScreen(commands: { name: string; desc: string }[]): string {
  const sections: string[] = [
    banner(),
    "",
    box("Usage", [
      "plasalid <command> [OPTIONS]",
      "plasalid                       Start the TUI chat session",
    ]),
    "",
  ];
  const nameWidth = Math.max(...commands.map((c) => c.name.length));
  const cmdLines = commands.map(
    (c) => `${chalk.white(c.name.padEnd(nameWidth))}    ${chalk.dim(c.desc)}`,
  );
  sections.push(box("Commands", cmdLines));
  sections.push("");
  sections.push(
    box("Options", [
      `${chalk.white("--version".padEnd(nameWidth))}    ${chalk.dim("Show the version and exit")}`,
      `${chalk.white("--help".padEnd(nameWidth))}    ${chalk.dim("Show this help screen")}`,
    ]),
  );
  sections.push("");
  sections.push(chalk.dim(DISCLAIMER));
  return sections.join("\n");
}

export function formatResponse(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (/^#{1,3}\s+/.test(line)) {
        return chalk.bold(line.replace(/^#{1,3}\s+/, ""));
      }
      line = line.replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(t));
      line = line.replace(/`([^`]+)`/g, (_, t) => chalk.cyan(t));
      line = line.replace(/(\d+(?:\.\d+)?%)/g, (m) => chalk.yellow(m));
      line = line.replace(
        /[+-]?(?:฿\s?[\d.,]+|[\d.,]+\s?(?:฿|THB|บาท))/g,
        (m) => (m.startsWith("-") ? chalk.red(m) : chalk.green(m)),
      );
      if (/^\s*[-•]\s/.test(line)) {
        line = line.replace(
          /^(\s*)([-•])(\s)/,
          (_, sp, b, s) => sp + chalk.dim(b) + s,
        );
      }
      return line;
    })
    .join("\n");
}
