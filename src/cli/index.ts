#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "module";
import { config, isConfigured } from "../config.js";
import { helpScreen } from "./format.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

const program = new Command();

function ensureConfigured(): void {
  if (!isConfigured()) {
    console.error("Plasalid is not configured. Run `plasalid setup` first.");
    process.exit(1);
  }
}

program
  .name("plasalid")
  .description("The local-first data layer for personal finance")
  .version(version)
  .addHelpCommand(false)
  .action(async () => {
    if (!isConfigured()) {
      console.log("Plasalid is not configured yet. Running setup...\n");
      const { runSetup } = await import("./setup.js");
      await runSetup();
      return;
    }
    const { startChat } = await import("./chat.js");
    await startChat();
  });

program
  .command("setup")
  .description("Configure Plasalid (API key, encryption, data directory)")
  .action(async () => {
    const { runSetup } = await import("./setup.js");
    await runSetup();
  });

program
  .command("data")
  .description("Open the Plasalid data folder in your OS file explorer")
  .action(async () => {
    const { runDataCommand } = await import("./commands/data.js");
    runDataCommand();
  });

program
  .command("accounts")
  .description("Show the chart of accounts with balances")
  .action(async () => {
    ensureConfigured();
    const { showAccounts } = await import("./commands/accounts.js");
    showAccounts();
  });

program
  .command("status")
  .description("Show net worth and this-month income/expense totals")
  .action(async () => {
    ensureConfigured();
    const { showStatus } = await import("./commands/status.js");
    showStatus();
  });

program
  .command("transactions")
  .description("List journal lines")
  .option("-a, --account <id>", "Filter by account id")
  .option("--from <date>", "From date YYYY-MM-DD")
  .option("--to <date>", "To date YYYY-MM-DD")
  .option("-q, --query <text>", "Free-text search on description / memo")
  .option("-n, --limit <number>", "Max results", "100")
  .action(async (opts) => {
    ensureConfigured();
    const { showTransactions } = await import("./commands/transactions.js");
    showTransactions({
      account: opts.account,
      from: opts.from,
      to: opts.to,
      query: opts.query,
      limit: Number(opts.limit),
    });
  });

program
  .command("scan [regex]")
  .description("Scan every new PDF under ~/.plasalid/data (optionally filtered by regex)")
  .option("-f, --force", "Re-scan matching files (cascade-deletes prior records)")
  .action(async (regex, opts) => {
    ensureConfigured();
    const { runScanCommand } = await import("./commands/scan.js");
    await runScanCommand({ regex, force: !!opts.force });
  });

program
  .command("reconcile")
  .description("Revisit the existing journal: find duplicate entries, similar accounts, and unused accounts; apply fixes after user confirmation")
  .option("-a, --account <id>", "Limit reconciliation to a single account")
  .option("--from <date>", "Only consider entries on or after this date (YYYY-MM-DD)")
  .option("--to <date>", "Only consider entries on or before this date (YYYY-MM-DD)")
  .option("-d, --dry-run", "Surface findings without applying any change")
  .action(async (opts) => {
    ensureConfigured();
    const { runReconcileCommand } = await import("./commands/reconcile.js");
    await runReconcileCommand({
      accountId: opts.account,
      from: opts.from,
      to: opts.to,
      dryRun: !!opts.dryRun,
    });
  });

program
  .command("revert <regex>")
  .description("Delete scanned files matching <regex> and all their journal entries")
  .action(async (regex) => {
    ensureConfigured();
    const { runRevertCommand } = await import("./commands/revert.js");
    await runRevertCommand(regex);
  });

program.configureHelp({
  formatHelp: () => helpScreen([
    { name: "setup", desc: "Configure Plasalid (API key, encryption, data dir)" },
    { name: "data", desc: "Open the data folder in your OS file explorer" },
    { name: "accounts", desc: "Show the chart of accounts with balances" },
    { name: "status", desc: "Show net worth and this-month totals" },
    { name: "transactions", desc: "List journal lines (filter by account/date/text)" },
    { name: "scan", desc: "Scan new PDFs (optionally by regex; --force to re-scan)" },
    { name: "reconcile", desc: "Review and fix existing journal entries / accounts" },
    { name: "revert", desc: "Delete scanned files matching <regex> and their journal entries" },
  ]),
});

void config; // keep config import live so dotenv loads
program.parse();
