import type { Command } from "commander";
import type {
  DuplicateTransactionRow,
  CorrelatedTransactionPair,
} from "../../db/queries/transactions.js";
import { fromMinorUnits } from "../../currency.js";
import { emitList, emitSummary, runAction, type Column } from "../output.js";

function accountsLabel(debitName: string | null, debitId: string, creditName: string | null, creditId: string): string {
  return `${debitName ?? debitId} -> ${creditName ?? creditId}`;
}

// Presentation rows: minor-unit amounts converted to decimals at the CLI boundary.
interface DuplicateRow extends Omit<DuplicateTransactionRow, "amount"> {
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

interface CorrelationRow extends Omit<CorrelatedTransactionPair, "amount"> {
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
    .description("Find likely duplicate transactions")
    .option("--auto-merge", "automatically merge detected duplicates")
    .action(
      runAction(async (opts: any) => {
        const { getDb } = await import("../../db/connection.js");
        const { findDuplicateTransactions } = await import("../../db/queries/transactions.js");
        const db = getDb();

        let autoMerged: number | undefined;
        if (opts.autoMerge) {
          const { autoMergeStrictDuplicateTransactions } = await import(
            "../../scanner/dedup-transactions.js"
          );
          autoMerged = autoMergeStrictDuplicateTransactions(db).merged;
        }

        const groups = findDuplicateTransactions(db);
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
    .description("Find correlated transactions across accounts")
    .action(
      runAction(async () => {
        const { getDb } = await import("../../db/connection.js");
        const { findCorrelatedTransactions } = await import("../../db/queries/transactions.js");
        const db = getDb();
        const pairs = findCorrelatedTransactions(db);
        const rows: CorrelationRow[] = pairs.map((p) => ({
          ...p,
          amount: fromMinorUnits(p.amount, p.currency),
        }));

        emitList(rows, CORRELATION_COLUMNS);
        emitSummary({ pairs: pairs.length });
      }),
    );
}
