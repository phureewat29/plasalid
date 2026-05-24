import chalk from "chalk";
import type Database from "libsql";
import { getDb } from "../../db/connection.js";
import { getNetWorth } from "../../db/queries/account-balance.js";
import { countTransactions } from "../../db/queries/transactions.js";
import { getRecurringSummary } from "../../db/queries/recurrences.js";
import { countScannedFiles } from "../../db/queries/files.js";
import { countQuestions } from "../../db/queries/questions.js";
import { countMemories } from "../../ai/memory.js";
import { config, getActiveModel } from "../../config.js";
import { formatAmount } from "../../currency.js";
import { banner, visibleLength } from "../format.js";

const LABEL_WIDTH = 18;

interface Row {
  label: string;
  value: string;
  suffix?: string;
}

export function showStatus(): void {
  const db = getDb();
  console.log("");
  console.log(banner());
  console.log("");
  printSection("Financial", financialRows(db));
  console.log("");
  printSection("System", systemRows(db));
  console.log("");
  printSection("Model", modelRows(), { align: "left" });
}

function financialRows(db: Database.Database): Row[] {
  const nw = getNetWorth(db);
  const rows: Row[] = [
    { label: "Net worth", value: formatAmount(nw.net_worth) },
    { label: "Assets", value: chalk.dim(formatAmount(nw.assets)) },
    { label: "Liabilities", value: chalk.dim(formatAmount(nw.liabilities)) },
  ];

  const recurring = getRecurringSummary(db);
  if (recurring.count > 0) {
    const monthly =
      recurring.monthly_estimate > 0
        ? ` · ${formatAmount(recurring.monthly_estimate)} / month (est.)`
        : "";
    rows.push({
      label: "Recurring",
      value: `${recurring.count} active${chalk.dim(monthly)}`,
    });
  }
  return rows;
}

function systemRows(db: Database.Database): Row[] {
  const tx = countTransactions(db);
  const files = countScannedFiles(db);
  const memories = countMemories(db);
  const questions = countQuestions(db);

  const rows: Row[] = [
    {
      label: "Transactions",
      value: formatInteger(tx.transactions),
      suffix:
        tx.postings > 0
          ? chalk.dim(`(${formatInteger(tx.postings)} postings)`)
          : undefined,
    },
  ];

  if (files.scanned + files.pending + files.failed > 0) {
    const extras: string[] = [];
    if (files.pending > 0) extras.push(`${files.pending} pending`);
    if (files.failed > 0) extras.push(chalk.red(`${files.failed} failed`));
    rows.push({
      label: "Scanned",
      value: formatInteger(files.scanned),
      suffix:
        extras.length > 0 ? chalk.dim(`(${extras.join(", ")})`) : undefined,
    });
  }

  if (memories > 0) {
    rows.push({ label: "Memories", value: formatInteger(memories) });
  }

  if (questions > 0) {
    rows.push({
      label: "Questions",
      value: chalk.yellow(formatInteger(questions)),
      suffix: chalk.dim("run `plasalid clarify`"),
    });
  }

  return rows;
}

function modelRows(): Row[] {
  return [
    { label: "Provider", value: config.providerType },
    { label: "Model", value: getActiveModel() },
  ];
}

function printSection(
  title: string,
  rows: Row[],
  opts?: { align?: "left" | "right" },
): void {
  const align = opts?.align ?? "right";
  console.log(chalk.bold.yellow(title));
  const valueWidth = Math.max(0, ...rows.map((r) => visibleLength(r.value)));
  for (const row of rows) {
    const label = row.label.padEnd(LABEL_WIDTH);
    const valuePad = " ".repeat(
      Math.max(0, valueWidth - visibleLength(row.value)),
    );
    const suffix = row.suffix ? `  ${row.suffix}` : "";
    const body =
      align === "left"
        ? `${row.value}${valuePad}${suffix}`
        : `${valuePad}${row.value}${suffix}`;
    console.log(`  ${label}${body}`);
  }
}

function formatInteger(n: number): string {
  return n.toLocaleString("en-US");
}
