import { Command, Help } from "commander";
import { createRequire } from "module";
import { config } from "../config.js";
import { helpScreen } from "./format.js";
import { runAction } from "./output.js";

// Harness command modules. Each registers its own noun + subcommand tree.
import { registerStatus, runStatus } from "./commands/status.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerSetup } from "./commands/setup.js";
import { registerConfig } from "./commands/config.js";
import { registerIngest } from "./commands/ingest.js";
import { registerFiles } from "./commands/files.js";
import { registerVault } from "./commands/vault.js";
import { registerTransactions } from "./commands/transactions.js";
import { registerAccounts } from "./commands/accounts.js";
import { registerMerchants } from "./commands/merchants.js";
import { registerQuestions } from "./commands/questions.js";
import { registerReport } from "./commands/report.js";
import { registerNotes } from "./commands/notes.js";

export const COMMANDS = [
  { name: "status", desc: "Harness status: config, database, ledger counts, net worth (default)" },
  { name: "doctor", desc: "Diagnose the harness environment" },
  { name: "setup", desc: "Install the skill pack for external agent CLIs (Claude Code, codex)" },
  { name: "config", desc: "Configure the harness (converge/init) and show configuration" },
  { name: "ingest", desc: "Ingest pipeline: list/prepare/commit/done/fail" },
  { name: "files", desc: "Browse scanned files (list/show/drop)" },
  { name: "vault", desc: "Manage file-password patterns for encrypted statements" },
  { name: "transactions", desc: "Transactions: list/show/add/update/delete/recategorize/dedupe" },
  { name: "accounts", desc: "Manage the chart of accounts" },
  { name: "merchants", desc: "Manage merchants and their default accounts" },
  { name: "questions", desc: "List, answer, and defer open questions" },
  { name: "report", desc: "Income/expenses/net over a date range (net worth: plasalid status)" },
  { name: "notes", desc: "Manage freeform notes" },
  { name: "data", desc: "Open the data folder in your OS file explorer (alias: open)" },
];

const GLOBAL_OPTIONS = [
  { name: "--json", desc: "Emit NDJSON (machine-readable) instead of human output" },
  { name: "--no-color", desc: "Disable ANSI color output" },
];

/**
 * Construct the full commander program: root command, every noun's
 * subcommand tree, global flags, and the branded root help screen. Pure
 * construction only — never parses argv or executes an action. Callers own
 * calling `.parse()` / `.parseAsync()`.
 */
export function buildProgram(): Command {
  const require = createRequire(import.meta.url);
  const { version } = require("../../package.json");

  const program = new Command();

  // Positional options: options are bound to the command level whose operand
  // (subcommand name) precedes them. Required so a parent command that has BOTH
  // a bare action and subcommands (config) dispatches its subcommand instead of
  // swallowing the operand's options into the bare action. Global --json/--no-color
  // live on every level (addGlobalOptions), so the OR-walk in getOutputMode still
  // sees them wherever they land.
  program.enablePositionalOptions();

  program
    .name("plasalid")
    .description("The Harness Layer for Personal Finance")
    .version(version)
    .addHelpCommand(false)
    .showHelpAfterError("Run `plasalid --help` for the list of commands.")
    // No-arg default action runs status (same implementation as the `status`
    // command), so `plasalid` on its own reports harness status.
    .action(
      runAction(async () => {
        await runStatus();
      }),
    );

  // `data` opens the OS file explorer at the data dir; a thin, db-free command.
  program
    .command("data")
    .alias("open")
    .description("Open the Plasalid data folder in your OS file explorer")
    .action(
      runAction(async () => {
        const { runDataCommand } = await import("./commands/data.js");
        await runDataCommand();
      }),
    );

  registerStatus(program);
  registerDoctor(program);
  registerSetup(program);
  registerConfig(program);
  registerIngest(program);
  registerFiles(program);
  registerVault(program);
  registerTransactions(program);
  registerAccounts(program);
  registerMerchants(program);
  registerQuestions(program);
  registerReport(program);
  registerNotes(program);

  // Global flags on EVERY command so they are accepted before or after the
  // subcommand (`plasalid --json vault list` and `plasalid vault list --json`).
  // getOutputMode() OR-walks the command chain, so wherever commander lands the
  // flag, the resolved mode sees it. Applied after registration so the whole tree
  // exists.
  function addGlobalOptions(cmd: Command): void {
    cmd
      .option("--json", "Emit NDJSON (machine-readable) instead of human output")
      .option("--no-color", "Disable ANSI color output");
    for (const sub of cmd.commands) addGlobalOptions(sub);
  }
  addGlobalOptions(program);

  program.configureHelp({
    // Root help stays the branded screen; subcommands fall back to commander's
    // default formatter so `plasalid <noun> --help` shows the real subcommand tree
    // (configureHelp is inherited by subcommands, hence the explicit root guard).
    formatHelp: (cmd, helper) =>
      cmd === program
        ? helpScreen(COMMANDS, GLOBAL_OPTIONS)
        : Help.prototype.formatHelp.call(helper, cmd, helper),
  });

  void config; // keep config import live so dotenv loads
  return program;
}
