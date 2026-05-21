import { memo, useMemo } from "react";
import { Box, Text } from "ink";
import chalk from "chalk";
import { formatAmount } from "../../currency.js";
import { truncateMiddle, padRight } from "../helper.js";
import { ListBrowser, type ListBrowserAdapter } from "./ListBrowser.js";
import {
  groupByTransaction,
  type PostingRow,
  type TransactionGroup,
} from "../../db/queries/transactions.js";

export interface TransactionsBrowserProps {
  postings: PostingRow[];
  filterSummary: string;
}

const RECURRING_MARKER = "[R]";
const DATE_WIDTH = 10;
const MIN_DESC_WIDTH = 12;

export function TransactionsBrowser({ postings, filterSummary }: TransactionsBrowserProps) {
  const items = useMemo(() => groupByTransaction(postings), [postings]);

  const adapter = useMemo<ListBrowserAdapter<TransactionGroup>>(() => ({
    title: "Transactions",
    filterSummary,
    items,
    getId: g => g.transaction_id,
    renderRow: (g, ctx) => renderTransactionRow(g, ctx.isCursor, ctx.isExpanded, ctx.cols),
    renderExpanded: g => <PostingsView group={g} />,
    getExpandedHeight: g => g.postings.length,
    matches: groupMatches,
    emptyMessage: "No transactions match the current filter.",
  }), [items, filterSummary]);

  return <ListBrowser adapter={adapter} />;
}

function renderTransactionRow(g: TransactionGroup, isCursor: boolean, isExpanded: boolean, cols: number): string {
  const totals = transactionTotals(g);
  const amountRaw = formatAmount(totals.amount, totals.currency);
  const recurringRaw = g.recurrence_id ? RECURRING_MARKER : "";

  // Layout: "M DDDDDDDDDD  <desc><merchant>  <amount><recurring>"
  // Fixed widths sum to: marker(1) + space + date(10) + 2 + 2 + amount + (recurring ? 2 + len : 0)
  const fixedWidth =
    1 + 1 + DATE_WIDTH + 2 + 2 + amountRaw.length + (recurringRaw ? 2 + RECURRING_MARKER.length : 0);
  const available = Math.max(MIN_DESC_WIDTH, cols - fixedWidth - 2);

  const merchantRaw = g.merchant ? `  · ${g.merchant}` : "";
  let description: string;
  let merchantText: string;
  if ((g.description.length + merchantRaw.length) <= available) {
    description = g.description;
    merchantText = merchantRaw;
  } else if (merchantRaw && merchantRaw.length > available / 2) {
    description = truncateMiddle(g.description, available);
    merchantText = "";
  } else {
    description = truncateMiddle(g.description, Math.max(MIN_DESC_WIDTH, available - merchantRaw.length));
    merchantText = merchantRaw;
  }

  const marker = isExpanded ? "▾" : isCursor ? "▸" : " ";
  const date = chalk.dim(g.date);
  const desc = isCursor ? chalk.cyan.bold(description) : description;
  const merchant = merchantText ? chalk.green(merchantText) : "";
  const amount = isCursor ? chalk.cyan(amountRaw) : amountRaw;
  const recurring = recurringRaw ? chalk.dim(`  ${recurringRaw}`) : "";

  return `${marker} ${date}  ${desc}${merchant}  ${amount}${recurring}`;
}

const PostingsView = memo(function PostingsView({ group }: { group: TransactionGroup }) {
  const accountWidth = Math.max(
    ...group.postings.map(p => (p.account_name ?? p.account_id).length),
  );
  return (
    <Box flexDirection="column" marginLeft={6}>
      {group.postings.map(p => {
        const side = p.debit > 0 ? "DR" : "CR";
        const amount = p.debit > 0 ? p.debit : p.credit;
        const color = p.debit > 0 ? chalk.cyan : chalk.magenta;
        const account = padRight(p.account_name ?? p.account_id, accountWidth);
        const memo = p.memo ? chalk.dim(`    ${p.memo}`) : "";
        return (
          <Text key={p.id}>
            {`${account}  ${color(`${side} ${formatAmount(amount, p.currency)}`)}${memo}`}
          </Text>
        );
      })}
    </Box>
  );
});

function transactionTotals(g: TransactionGroup): { amount: number; currency: string } {
  let amount = 0;
  for (const p of g.postings) amount += p.debit;
  return { amount, currency: g.postings[0]?.currency ?? "THB" };
}

function groupMatches(g: TransactionGroup, needle: string): boolean {
  if (g.description.toLowerCase().includes(needle)) return true;
  if (g.merchant && g.merchant.toLowerCase().includes(needle)) return true;
  for (const p of g.postings) {
    if (p.memo && p.memo.toLowerCase().includes(needle)) return true;
    if (p.account_name && p.account_name.toLowerCase().includes(needle)) return true;
  }
  return false;
}
