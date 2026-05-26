import chalk from "chalk";
import { pickQuote, type Quote } from "./quotes.js";

export async function startChat(): Promise<void> {
  const { getDb } = await import("../db/connection.js");
  const db = getDb();

  console.log("");
  renderQuote(pickQuote());
  console.log("");

  const accountCount = db
    .prepare(`SELECT COUNT(*) AS n FROM accounts`)
    .get() as { n: number };
  if (accountCount.n === 0) {
    console.log(
      chalk.yellow(
        "No accounts scanned yet. Run `plasalid data` to drop your bank/credit card statements in, then run `plasalid scan`.",
      ),
    );
    console.log("");
  }

  console.log(
    centerLine("Ready when you are. Ask Plasalid anything about your money."),
  );
  console.log("");

  const { runChatApp } = await import("./ink/mount.js");
  await runChatApp({ db });
}

const MIN_WRAP = 32;
const MAX_WRAP = 100;
const WRAP_RATIO = 0.7;

function renderQuote(q: Quote): void {
  const cols = process.stdout.columns || 80;
  const wrapWidth = Math.min(MAX_WRAP, Math.max(MIN_WRAP, Math.floor(cols * WRAP_RATIO)));
  const lines = wrapText(q.text, wrapWidth).map(wrapInQuotes);
  const blockWidth = Math.max(...lines.map((l) => l.length));
  const leftPad = " ".repeat(Math.max(0, Math.floor((cols - blockWidth) / 2)));
  const author = `— ${q.author}`;
  const authorPad = " ".repeat(Math.max(0, leftPad.length + blockWidth - author.length));

  const out = [...lines.map((l) => leftPad + l), "", authorPad + author, ""];
  for (const line of out) console.log(chalk.dim(line));
}

function wrapInQuotes(line: string, i: number, all: string[]): string {
  const open = i === 0 ? "“" : " ";
  const close = i === all.length - 1 ? "”" : "";
  return `${open}${line}${close}`;
}

function centerLine(text: string): string {
  const cols = process.stdout.columns || 80;
  return " ".repeat(Math.max(0, Math.floor((cols - text.length) / 2))) + text;
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
