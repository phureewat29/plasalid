import type { Command } from "commander";
import { getDb } from "../../db/connection.js";
import { currentMode, emit, emitItem, emitList, fail, runAction, type Column } from "../output.js";
import {
  listTransfers,
  getTransfer,
  type ListTransfersOptions,
  type TransferRow,
  type TransferCluster,
} from "../../db/queries/transfers.js";
import { fromMinorUnits } from "../../currency.js";
import { applyRedaction } from "../../privacy/redactor.js";

/**
 * `ledger` — the read view over the TigerBeetle-style `transfers` table.
 * `ledger` (bare) lists transfers; `ledger show <tf:id>` inspects one (with its
 * linked group when present). Amounts are stored as integer minor units and
 * rendered/emitted as decimals here (the CLI boundary).
 */

// Free-text fields on a transfer that may carry PII. Ids, amount, currency, and
// dates are structured data the agent needs verbatim and are left intact.
const LEDGER_REDACT_FIELDS = [
  "description",
  "raw_descriptor",
  "merchant_name",
  "debit_account_name",
  "credit_account_name",
] as const;

/** A transfer row with its stored minor-unit amount converted to a decimal. */
type LedgerView = Omit<TransferRow, "amount"> & { amount: number };

function present(row: TransferRow): LedgerView {
  return { ...row, amount: fromMinorUnits(row.amount, row.currency) };
}

const LEDGER_COLUMNS: Column<LedgerView>[] = [
  { header: "ID", value: (t) => t.id },
  { header: "Date", value: (t) => t.date },
  { header: "Description", value: (t) => t.description },
  { header: "Debit", value: (t) => t.debit_account_name ?? t.debit_account_id },
  { header: "Credit", value: (t) => t.credit_account_name ?? t.credit_account_id },
  { header: "Amount", value: (t) => t.amount.toFixed(2), align: "right" },
  { header: "Currency", value: (t) => t.currency },
];

function parseOptionalNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) fail("USAGE", `${flag} must be a number, got "${value}"`);
  return n;
}

interface LedgerListOpts {
  account?: string;
  from?: string;
  to?: string;
  query?: string;
  limit?: string;
  group?: boolean;
  redact?: boolean;
}

function runList(opts: LedgerListOpts): void {
  const db = getDb();
  const listOpts: Omit<ListTransfersOptions, "group"> = {};
  if (opts.account) listOpts.account = opts.account;
  if (opts.from) listOpts.from = opts.from;
  if (opts.to) listOpts.to = opts.to;
  if (opts.query) listOpts.query = opts.query;
  const limit = parseOptionalNumber(opts.limit, "--limit");
  if (limit !== undefined) listOpts.limit = limit;

  if (opts.group) {
    const clusters = listTransfers(db, { ...listOpts, group: true });
    emitClusters(clusters, !!opts.redact);
    return;
  }

  const rows = applyRedaction(
    listTransfers(db, listOpts).map(present),
    !!opts.redact,
    LEDGER_REDACT_FIELDS,
  );
  emitList(rows, LEDGER_COLUMNS);
}

function emitClusters(clusters: TransferCluster[], redact: boolean): void {
  const view = clusters.map((c) => ({
    group_id: c.group_id,
    transfers: applyRedaction(c.transfers.map(present), redact, LEDGER_REDACT_FIELDS),
  }));
  const mode = currentMode();
  if (mode.json) {
    for (const c of view) emitItem(c);
    return;
  }
  for (const c of view) {
    process.stdout.write(`${c.group_id ?? "(ungrouped)"}\n`);
    for (const t of c.transfers) {
      process.stdout.write(
        `  ${t.id}  ${t.date}  ${t.description}  ${t.debit_account_name ?? t.debit_account_id} -> ${t.credit_account_name ?? t.credit_account_id}  ${t.amount.toFixed(2)} ${t.currency}\n`,
      );
    }
  }
}

function runShow(id: string, opts: { redact?: boolean }): void {
  const db = getDb();
  const detail = getTransfer(db, id);
  if (!detail) fail("NOT_FOUND", `transfer "${id}" not found`);

  const view: Record<string, unknown> = present(detail);
  if (detail.group) view.group = detail.group.map(present);
  emit(applyRedaction(view, !!opts.redact, LEDGER_REDACT_FIELDS));
}

export function registerLedger(program: Command): void {
  const ledger = program
    .command("ledger")
    // ledger has a bare list action AND a `show` subcommand that share the
    // --redact option; positional options make options AFTER `show` bind to it
    // instead of being swallowed by the parent list action.
    .enablePositionalOptions()
    .description("Browse the transfer ledger (bare = list)")
    .option("--account <id>", "filter by account id (matches either side)")
    .option("--from <date>", "filter from date")
    .option("--to <date>", "filter to date")
    .option("--query <text>", "filter by search text")
    .option("--limit <n>", "maximum number of results")
    .option("--group", "fold linked transfers into their group clusters")
    .option("--redact", "mask PII in free-text fields (descriptions, merchant/account names)")
    .action(runAction((opts: LedgerListOpts) => runList(opts)));

  ledger
    .command("show <id>")
    .description("Show a transfer's details (with its linked group when present)")
    .option("--redact", "mask PII in free-text fields (description, merchant/account names)")
    .action(runAction((id: string, opts: { redact?: boolean }) => runShow(id, opts)));
}
