import chalk from "chalk";

// eslint-disable-next-line no-control-regex
export const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

export function banner(): string {
  return (
    chalk.cyan("<°(((><  ") +
    chalk.bold("Plasalid") +
    chalk.dim("  ·  The Harness Layer for Personal Finance")
  );
}

const DISCLAIMER =
  "Plasalid is an assistant, it only summarizes financial statements — verify amounts against your statements before relying on them.";

function section(label: string, lines: string[]): string {
  return [chalk.bold.yellow(label), ...lines.map((l) => `  ${l}`)].join("\n");
}

export function helpScreen(
  commands: { name: string; desc: string }[],
  extraOptions: { name: string; desc: string }[] = [],
): string {
  const options: { name: string; desc: string }[] = [
    ...extraOptions,
    { name: "--version", desc: "Show the version and exit" },
    { name: "--help", desc: "Show this help screen" },
  ];
  const nameWidth = Math.max(
    ...commands.map((c) => c.name.length),
    ...options.map((o) => o.name.length),
  );
  const row = (name: string, desc: string) =>
    `${chalk.cyan(name.padEnd(nameWidth))}    ${chalk.dim(desc)}`;

  const usageLines = [
    row("plasalid", "<command> [OPTIONS]"),
    row("plasalid", "Show harness status (default)"),
  ];

  return [
    "",
    banner(),
    "",
    section("Usage", usageLines),
    "",
    section("Commands", commands.map((c) => row(c.name, c.desc))),
    "",
    section("Options", options.map((o) => row(o.name, o.desc))),
    "",
    chalk.dim(DISCLAIMER),
  ].join("\n");
}
