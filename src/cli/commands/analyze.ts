import type { Command } from "commander";
import type {
  DuplicateTransferRow,
  CorrelatedTransferPair,
} from "../../db/queries/transfers.js";
import { fromMinorUnits } from "../../currency.js";
import { emitList, emitSummary, fail, runAction, type Column } from "../output.js";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseNumberOpt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) fail("USAGE", `${name} must be a number, got "${raw}"`);
  return n;
}

function accountsLabel(debitName: string | null, debitId: string, creditName: string | null, creditId: string): string {
  return `${debitName ?? debitId} -> ${creditName ?? creditId}`;
}

// Presentation rows: minor-unit amounts converted to decimals at the CLI boundary.
interface DuplicateRow extends Omit<DuplicateTransferRow, "amount"> {
  amount: number;
  group: number;
}

const DUPLICATE_COLUMNS: Column<DuplicateRow>[] = [
  { header: "group", value: (r) => String(r.group), align: "right" },
  { header: "id", value: (r) => r.id },
  { header: "date", value: (r) => r.date },
  { header: "amount", value: (r) => r.amount.toFixed(2), align: "right" },
  { header: "currency", value: (r) => r.currency },
  { header: "description", value: (r) => r.description },
  { header: "accounts", value: (r) => accountsLabel(r.debit_account_name, r.debit_account_id, r.credit_account_name, r.credit_account_id) },
  { header: "source_file_id", value: (r) => r.source_file_id ?? "" },
  { header: "merchant_id", value: (r) => r.merchant_id ?? "" },
];

interface CorrelationRow extends Omit<CorrelatedTransferPair, "amount"> {
  amount: number;
}

const CORRELATION_COLUMNS: Column<CorrelationRow>[] = [
  { header: "amount", value: (r) => r.amount.toFixed(2), align: "right" },
  { header: "currency", value: (r) => r.currency },
  { header: "day_gap", value: (r) => String(r.day_gap), align: "right" },
  { header: "a_id", value: (r) => r.a.id },
  { header: "a_date", value: (r) => r.a.date },
  { header: "a_description", value: (r) => r.a.description },
  { header: "a_accounts", value: (r) => accountsLabel(r.a.debit_account_name, r.a.debit_account_id, r.a.credit_account_name, r.a.credit_account_id) },
  { header: "b_id", value: (r) => r.b.id },
  { header: "b_date", value: (r) => r.b.date },
  { header: "b_description", value: (r) => r.b.description },
  { header: "b_accounts", value: (r) => accountsLabel(r.b.debit_account_name, r.b.debit_account_id, r.b.credit_account_name, r.b.credit_account_id) },
];

export function registerAnalyze(program: Command): void {
  const analyze = program.command("analyze").description("Analyze ledger data");

  analyze
    .command("duplicates")
    .description("Find likely duplicate transfers")
    .option("--tolerance-days <n>", "date tolerance in days")
    .option("--account <id>", "filter by account id")
    .option("--min-amount <n>", "minimum amount to consider")
    .option("--auto-merge", "automatically merge detected duplicates")
    .action(
      runAction(async (opts: any) => {
        const toleranceDays = parseNumberOpt(opts.toleranceDays, "--tolerance-days", 2);
        const minAmount = parseNumberOpt(opts.minAmount, "--min-amount", 0);

        const { getDb } = await import("../../db/connection.js");
        const { findDuplicateTransfers } = await import("../../db/queries/transfers.js");
        const db = getDb();

        let autoMerged: number | undefined;
        if (opts.autoMerge) {
          const { autoMergeStrictDuplicateTransfers } = await import(
            "../../scanner/dedup-transfers.js"
          );
          autoMerged = autoMergeStrictDuplicateTransfers(db).merged;
        }

        const groups = findDuplicateTransfers(db, {
          toleranceDays,
          accountId: opts.account,
          minAmount,
        });
        const rows: DuplicateRow[] = groups.flatMap((group, i) =>
          group.map((t) => ({ ...t, amount: fromMinorUnits(t.amount, t.currency), group: i })),
        );

        emitList(rows, DUPLICATE_COLUMNS);
        emitSummary({
          groups: groups.length,
          ...(autoMerged !== undefined ? { auto_merged: autoMerged } : {}),
        });
      }),
    );

  analyze
    .command("correlations")
    .description("Find correlated transfers across accounts")
    .option("--from <date>", "start date")
    .option("--to <date>", "end date")
    .option("--tolerance-days <n>", "date tolerance in days")
    .option("--min-amount <n>", "minimum amount to consider")
    .action(
      runAction(async (opts: any) => {
        if (opts.from && !ISO_DATE_RE.test(opts.from)) {
          fail("USAGE", `--from must be an ISO date (YYYY-MM-DD), got "${opts.from}"`);
        }
        if (opts.to && !ISO_DATE_RE.test(opts.to)) {
          fail("USAGE", `--to must be an ISO date (YYYY-MM-DD), got "${opts.to}"`);
        }
        const toleranceDays = parseNumberOpt(opts.toleranceDays, "--tolerance-days", 3);
        const minAmount = parseNumberOpt(opts.minAmount, "--min-amount", 0);

        const { getDb } = await import("../../db/connection.js");
        const { findCorrelatedTransfers } = await import("../../db/queries/transfers.js");
        const db = getDb();
        const pairs = findCorrelatedTransfers(db, {
          from: opts.from,
          to: opts.to,
          toleranceDays,
          minAmount,
        });
        const rows: CorrelationRow[] = pairs.map((p) => ({
          ...p,
          amount: fromMinorUnits(p.amount, p.currency),
        }));

        emitList(rows, CORRELATION_COLUMNS);
        emitSummary({ pairs: pairs.length });
      }),
    );
}
