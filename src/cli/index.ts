#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "module";
import chalk from "chalk";
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
  .description("The Harness Layer for Personal Finance")
  .version(version)
  .addHelpCommand(false)
  .showHelpAfterError(
    `Run ${chalk.cyan("plasalid --help")} for the list of commands.`,
  )
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
  .alias("open")
  .description("Open the Plasalid data folder in your OS file explorer")
  .action(async () => {
    const { runDataCommand } = await import("./commands/data.js");
    runDataCommand();
  });

program
  .command("accounts")
  .description("Browse the chart of accounts with balances (interactive TTY) or print them (piped)")
  .option("--no-interactive", "Force plain-print output instead of the Ink browser")
  .action(async (opts) => {
    ensureConfigured();
    const { showAccounts } = await import("./commands/accounts.js");
    await showAccounts({ noInteractive: opts.interactive === false });
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
  .description("Browse transactions (interactive TTY) or print them (piped)")
  .option("-a, --account <id>", "Filter by account id")
  .option("--from <date>", "From date YYYY-MM-DD")
  .option("--to <date>", "To date YYYY-MM-DD")
  .option("-q, --query <text>", "Free-text search on description / memo")
  .option("-n, --limit <number>", "Max results (default 1000 interactive, 100 piped)")
  .option("--no-interactive", "Force plain-print output instead of the Ink browser")
  .action(async (opts) => {
    ensureConfigured();
    const { showTransactions } = await import("./commands/transactions.js");
    await showTransactions({
      account: opts.account,
      from: opts.from,
      to: opts.to,
      query: opts.query,
      limit: opts.limit != null ? Number(opts.limit) : undefined,
      // commander inverts --no-foo to `opts.foo = false`
      noInteractive: opts.interactive === false,
    });
  });

program
  .command("record <utterance...>")
  .description(
    "Add a manual entry, account, or balance update from a plain-language line.",
  )
  .action(async (utteranceTokens: string[]) => {
    ensureConfigured();
    const { runRecordCommand } = await import("./commands/record.js");
    await runRecordCommand({ utterance: utteranceTokens.join(" ") });
  });

program
  .command("scan [regex...]")
  .description(
    "Scan every new PDF under ~/.plasalid/data (optionally filtered by regex)",
  )
  .option(
    "-f, --force",
    "Re-scan matching files (cascade-deletes prior records)",
  )
  .option(
    "-p, --parallel <n>",
    "Number of files to scan concurrently (default 3, max 8). Override env PLASALID_SCAN_CONCURRENCY.",
    (v) => parseInt(v, 10),
  )
  .action(async (regexes: string[], opts) => {
    ensureConfigured();
    if (regexes.length > 1) {
      console.error(
        chalk.red(
          `scan takes a single regex (or none). got ${regexes.length} arguments — your shell likely expanded a glob like '*' to filenames.`,
        ),
      );
      console.error("");
      console.error("To scan everything in the data dir:");
      console.error(`  ${chalk.cyan("plasalid scan")}`);
      console.error("");
      console.error("To filter with a regex, quote it:");
      console.error(`  ${chalk.cyan("plasalid scan '.*'")}`);
      console.error(`  ${chalk.cyan("plasalid scan 'KBank|SCB'")}`);
      process.exit(1);
    }
    const envParallel = parseInt(
      process.env.PLASALID_SCAN_CONCURRENCY ?? "",
      10,
    );
    const parallel = Number.isFinite(opts.parallel)
      ? opts.parallel
      : Number.isFinite(envParallel)
        ? envParallel
        : undefined;
    const { runScanCommand } = await import("./commands/scan.js");
    await runScanCommand({ regex: regexes[0], force: !!opts.force, parallel });
  });

program
  .command("resolve")
  .description(
    "Walk every open unknown from the last scan one at a time and apply your decision (categorize, merge duplicates, link recurrences, skip).",
  )
  .option("-a, --account <id>", "Limit to unknowns attached to a single account")
  .option(
    "--from <date>",
    "Only consider entries on or after this date (YYYY-MM-DD)",
  )
  .option(
    "--to <date>",
    "Only consider entries on or before this date (YYYY-MM-DD)",
  )
  .option(
    "-k, --kind <kind>",
    "Filter by unknown kind (uncategorized_expense, duplicate, correlation, recurrence_candidate, similar_accounts)",
  )
  .action(async (opts) => {
    ensureConfigured();
    const { runResolveCommand } = await import("./commands/resolve.js");
    await runResolveCommand({
      accountId: opts.account,
      from: opts.from,
      to: opts.to,
      kind: opts.kind,
    });
  });

program
  .command("rules")
  .description("List rules the system has learned")
  .action(async () => {
    ensureConfigured();
    const { showRules } = await import("./commands/rules.js");
    showRules();
  });

program
  .command("forget <regex>")
  .description(
    "Delete every learned rule whose id matches <regex> (anchored). Run `plasalid rules` to list ids.",
  )
  .action(async (regex: string) => {
    ensureConfigured();
    const { forgetRule } = await import("./commands/rules.js");
    forgetRule(regex);
  });

program
  .command("revert <regex>")
  .description(
    "Delete scanned files matching <regex> and all their transactions",
  )
  .action(async (regex) => {
    ensureConfigured();
    const { runRevertCommand } = await import("./commands/revert.js");
    await runRevertCommand(regex);
  });

program.configureHelp({
  formatHelp: () =>
    helpScreen([
      {
        name: "setup",
        desc: "Configure Plasalid (API key, encryption, data dir)",
      },
      {
        name: "data",
        desc: "Open the data folder in your OS file explorer (alias: open)",
      },
      { name: "accounts", desc: "Browse the chart of accounts (interactive TTY) or list them (piped)" },
      { name: "status", desc: "Show financial and system status (net worth, recurring, unknowns)" },
      {
        name: "transactions",
        desc: "Browse transactions (interactive TTY) or list them (piped/--no-interactive)",
      },
      {
        name: "record",
        desc: "Add a manual transaction, account, balance, or merchant from a plain-language line",
      },
      {
        name: "scan",
        desc: "Scan new PDFs (optionally by regex; --force to re-scan)",
      },
      {
        name: "resolve",
        desc: "Walk open unknowns one at a time and apply your decision",
      },
      {
        name: "rules",
        desc: "List rules the system has learned",
      },
      {
        name: "forget",
        desc: "Delete learned rules whose ids match <regex> (anchored)",
      },
      {
        name: "revert",
        desc: "Delete scanned files matching <regex> and their transactions",
      },
    ]),
});

void config; // keep config import live so dotenv loads
program.parse();
