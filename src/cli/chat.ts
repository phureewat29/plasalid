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
    chalk.dim("Ready when you are. Ask Plasalid anything about your money."),
  );
  console.log("");

  const { runChatApp } = await import("./ink/mount.js");
  await runChatApp({ db });
}

const MAX_COL_WIDTH = 80;
const MAX_WRAP_WIDTH = 56;
const MIN_WRAP_WIDTH = 24;
const MAX_LEFT_PAD = 4;

function renderQuote(q: Quote): void {
  const cols = Math.min(process.stdout.columns || MAX_COL_WIDTH, MAX_COL_WIDTH);
  const wrapWidth = Math.min(MAX_WRAP_WIDTH, Math.max(MIN_WRAP_WIDTH, cols - 8));

  const lines = wrapText(q.text, wrapWidth);
  const decorated = lines.map((line, i) => decorateQuote(line, i, lines.length));
  const blockWidth = Math.max(...decorated.map((l) => l.length));
  const centeredPad = Math.max(0, Math.floor((cols - blockWidth) / 2));
  const leftPad = Math.min(MAX_LEFT_PAD, centeredPad);

  for (const line of decorated) {
    console.log(chalk.dim(" ".repeat(leftPad) + line));
  }
  console.log("");

  const author = `— ${q.author}`;
  const authorPad = Math.max(leftPad, leftPad + blockWidth - author.length);
  console.log(chalk.dim(" ".repeat(authorPad) + author));
  console.log("");
}

function decorateQuote(line: string, index: number, total: number): string {
  const open = index === 0 ? "“" : " ";
  const close = index === total - 1 ? "”" : "";
  return `${open}${line}${close}`;
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
