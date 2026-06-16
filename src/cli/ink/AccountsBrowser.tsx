import { memo, useMemo } from "react";
import { Box, Text } from "ink";
import chalk from "chalk";
import { formatAmount, formatSignedAmount } from "../../currency.js";
import { padRight, truncateMiddle } from "../helper.js";
import { ListBrowser, type ListBrowserAdapter } from "./ListBrowser.js";
import type {
  AccountBalance,
  AccountType,
} from "../../db/queries/account-balance.js";
import type { PostingRow } from "../../db/queries/transactions.js";

export interface AccountsBrowserProps {
  accounts: AccountBalance[];
  recentTransactionsByAccount: Map<string, PostingRow[]>;
}

const TYPE_TAG: Record<AccountType, string> = {
  asset: "asset",
  liability: "liab",
  income: "income",
  expense: "expense",
  equity: "equity",
};
const TYPE_TAG_WIDTH = 8;
const TYPE_RANK: Record<AccountType, number> = {
  asset: 0,
  liability: 1,
  income: 2,
  expense: 3,
  equity: 4,
};
const MIN_NAME_WIDTH = 12;

interface PrecomputedAccount {
  item: AccountBalance;
  indent: string;
  displayName: string;
  balanceText: string;
  meta: string[];
}

export function AccountsBrowser({ accounts, recentTransactionsByAccount }: AccountsBrowserProps) {
  const sorted = useMemo(() => {
    return [...accounts].sort((a, b) => {
      const t = TYPE_RANK[a.type] - TYPE_RANK[b.type];
      if (t !== 0) return t;
      return a.id.localeCompare(b.id);
    });
  }, [accounts]);

  const precomputed = useMemo<PrecomputedAccount[]>(() => {
    const byId = new Map(sorted.map(a => [a.id, a]));
    const depthCache = new Map<string, number>();
    const depthOf = (id: string): number => {
      const cached = depthCache.get(id);
      if (cached !== undefined) return cached;
      const node = byId.get(id);
      if (!node || !node.parent_id) {
        depthCache.set(id, 0);
        return 0;
      }
      const d = depthOf(node.parent_id) + 1;
      depthCache.set(id, d);
      return d;
    };

    return sorted.map(a => ({
      item: a,
      indent: "  ".repeat(depthOf(a.id)),
      displayName: a.name,
      balanceText: formatSignedAmount(a.balance),
      meta: compactMeta(a),
    }));
  }, [sorted]);

  const adapter = useMemo<ListBrowserAdapter<PrecomputedAccount>>(() => ({
    title: "Accounts",
    items: precomputed,
    getId: p => p.item.id,
    renderRow: (p, ctx) => renderAccountRow(p, ctx.isCursor, ctx.isExpanded, ctx.cols),
    renderExpanded: p => (
      <RecentTransactionsView postings={recentTransactionsByAccount.get(p.item.id) ?? []} />
    ),
    getExpandedHeight: p => {
      const n = recentTransactionsByAccount.get(p.item.id)?.length ?? 0;
      return n > 0 ? n : 1;  // 1 for the empty-state line
    },
    matches: (p, needle) => accountMatches(p.item, needle),
    emptyMessage: "No accounts yet. Run `plasalid scan` to ingest statements.",
  }), [precomputed, recentTransactionsByAccount]);

  return <ListBrowser adapter={adapter} />;
}

function renderAccountRow(
  p: PrecomputedAccount,
  isCursor: boolean,
  isExpanded: boolean,
  cols: number,
): string {
  const a = p.item;
  const marker = isExpanded ? "▾" : isCursor ? "▸" : " ";
  const tag = chalk.dim(padRight(TYPE_TAG[a.type], TYPE_TAG_WIDTH));
  const balanceRaw = p.balanceText;
  const metaRaw = p.meta.join(" · ");

  // Layout: "M tag(8)  name  balance[  meta...]"
  // Just spacing, no column alignment. Balance follows the name directly,
  // meta (if any) follows the balance. Truncate name to whatever room remains.
  const fixedWidth =
    1 + 1 + TYPE_TAG_WIDTH + 2 + 2 + balanceRaw.length + (metaRaw ? 2 + metaRaw.length : 0);
  const nameBudget = Math.max(MIN_NAME_WIDTH, cols - fixedWidth - 2);
  const nameRaw = truncateMiddle(p.indent + p.displayName, nameBudget);

  const name = isCursor ? chalk.cyan.bold(nameRaw) : chalk.bold(nameRaw);
  const balance = isCursor
    ? chalk.cyan(balanceRaw)
    : a.balance < 0
    ? chalk.red(balanceRaw)
    : a.balance > 0
    ? chalk.green(balanceRaw)
    : balanceRaw;
  const meta = metaRaw ? `  ${chalk.dim(metaRaw)}` : "";

  return `${marker} ${tag}  ${name}  ${balance}${meta}`;
}

function compactMeta(a: AccountBalance): string[] {
  const meta: string[] = [];
  if (a.bank_name) meta.push(a.bank_name);
  if (a.due_day) meta.push(`due ${a.due_day}`);
  if (a.statement_day) meta.push(`stmt ${a.statement_day}`);
  if (a.points_balance) meta.push(`${a.points_balance.toLocaleString()} pts`);
  if (a.currency && a.currency !== "THB") meta.push(a.currency);
  if (meta.length === 0 && a.subtype) meta.push(a.subtype);
  return meta;
}

function accountMatches(a: AccountBalance, needle: string): boolean {
  if (a.name.toLowerCase().includes(needle)) return true;
  if (a.id.toLowerCase().includes(needle)) return true;
  if (a.bank_name && a.bank_name.toLowerCase().includes(needle)) return true;
  if (a.subtype && a.subtype.toLowerCase().includes(needle)) return true;
  return false;
}

const DATE_WIDTH = 10;
const MIN_DESC_WIDTH_DETAIL = 16;

const RecentTransactionsView = memo(function RecentTransactionsView({
  postings,
}: { postings: PostingRow[] }) {
  if (postings.length === 0) {
    return (
      <Box flexDirection="column" marginLeft={6}>
        <Text dimColor>No recent activity on this account.</Text>
      </Box>
    );
  }

  // Pre-compute the amount column width so amounts line up.
  const amountColumn = postings.map(p => {
    const side = p.debit > 0 ? "DR" : "CR";
    const amount = p.debit > 0 ? p.debit : p.credit;
    return `${side} ${formatAmount(amount, p.currency)}`;
  });
  const amountWidth = Math.max(...amountColumn.map(s => s.length));

  return (
    <Box flexDirection="column" marginLeft={6}>
      {postings.map((p, i) => {
        const date = chalk.dim(padRight(p.transaction_date ?? "", DATE_WIDTH));
        const merchantText = p.merchant_name ? `  · ${p.merchant_name}` : "";
        const description = p.transaction_description ?? "";
        const memoText = p.memo ? `    ${chalk.dim(p.memo)}` : "";

        // Pad amount to its column, then color.
        const amountRaw = amountColumn[i];
        const amountPadded = padRight(amountRaw, amountWidth);
        const color = p.debit > 0 ? chalk.cyan : chalk.magenta;
        const amount = color(amountPadded);

        // Truncate description+merchant to whatever room remains.
        const descBudget = Math.max(MIN_DESC_WIDTH_DETAIL, 80 - merchantText.length);
        const desc = truncateMiddle(description, descBudget);
        const merchant = merchantText ? chalk.green(merchantText) : "";

        return (
          <Text key={p.id}>
            {`${date}  ${desc}${merchant}   ${amount}${memoText}`}
          </Text>
        );
      })}
    </Box>
  );
});

