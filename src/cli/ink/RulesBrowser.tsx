import { useMemo, useState } from "react";
import type Database from "libsql";
import { Text } from "ink";
import chalk from "chalk";
import { padRight, truncateMiddle } from "../helper.js";
import { ListBrowser, type ListBrowserAdapter } from "./ListBrowser.js";
import { keyOf } from "./keys.js";
import type { RuleEntry } from "../commands/rules.js";

export interface RulesBrowserProps {
  rules: RuleEntry[];
  db: Database.Database;
}

const MIN_TEXT_WIDTH = 16;

export function RulesBrowser({ rules: initialRules, db }: RulesBrowserProps) {
  const [rules, setRules] = useState<RuleEntry[]>(initialRules);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const idWidth = useMemo(
    () => (rules.length === 0 ? 0 : Math.max(...rules.map((r) => r.displayId.length))),
    [rules],
  );

  const adapter = useMemo<ListBrowserAdapter<RuleEntry>>(() => {
    const commitDelete = (): void => {
      const target = rules.find((r) => r.displayId === confirmId);
      if (target) {
        target.forget(db);
        setRules((prev) => prev.filter((r) => r.displayId !== confirmId));
      }
      setConfirmId(null);
    };
    const cancelConfirm = (): void => setConfirmId(null);

    const CONFIRM_KEYS: Record<string, () => void> = {
      y:      commitDelete,
      n:      cancelConfirm,
      escape: cancelConfirm,
    };
    const BROWSE_KEYS: Record<string, (cursorItem: RuleEntry | null) => boolean> = {
      d: (cursorItem) => {
        if (!cursorItem) return false;
        setConfirmId(cursorItem.displayId);
        return true;
      },
    };

    return {
      title: "Rules",
      items: rules,
      getId: (r) => r.displayId,
      renderRow: (r, ctx) => renderRuleRow(r, ctx.isCursor, ctx.cols, idWidth),
      matches: (r, needle) =>
        r.displayId.toLowerCase().includes(needle) ||
        r.text.toLowerCase().includes(needle),
      emptyMessage:
        "No rules yet. Rules accumulate as you clarify questions. Run `plasalid clarify` after a scan.",
      summary: confirmId ? (
        <Text color="yellow">{`Delete ${confirmId}? (y/n)`}</Text>
      ) : undefined,
      onKey: (input, key, { cursorItem }) => {
        const k = keyOf(input, key).toLowerCase();
        if (confirmId !== null) {
          CONFIRM_KEYS[k]?.();
          return true; // confirm mode swallows everything else
        }
        return BROWSE_KEYS[k]?.(cursorItem) ?? false;
      },
    };
  }, [rules, idWidth, confirmId, db]);

  return <ListBrowser adapter={adapter} />;
}

function renderRuleRow(
  r: RuleEntry,
  isCursor: boolean,
  cols: number,
  idWidth: number,
): string {
  const marker = isCursor ? "▸" : " ";
  const idPadded = padRight(r.displayId, idWidth);
  const id = isCursor ? chalk.cyan.bold(idPadded) : chalk.cyan(idPadded);

  // Layout: "M idPadded  text" → marker(1) + space + idPadded + 2 + text
  const fixedWidth = 1 + 1 + idWidth + 2;
  const textBudget = Math.max(MIN_TEXT_WIDTH, cols - fixedWidth - 2);
  const textRaw = truncateMiddle(r.text, textBudget);
  const text = isCursor ? chalk.bold(textRaw) : textRaw;

  return `${marker} ${id}  ${text}`;
}
