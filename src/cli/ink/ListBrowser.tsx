import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";

const HEADER_LINES = 2;       // title + rule
const FOOTER_LINES = 2;       // rule + hint
const SUMMARY_LINES = 1;      // optional aggregate footer
const RESERVED_LINES = HEADER_LINES + FOOTER_LINES + SUMMARY_LINES + 1; // +1 breathing room

export interface ListBrowserAdapter<T> {
  title: string;
  filterSummary?: string;
  items: T[];
  getId: (item: T) => string;
  /** Returns the row as a single ANSI-colored string for the given context. */
  renderRow: (item: T, ctx: { isCursor: boolean; isExpanded: boolean; cols: number }) => string;
  /** Optional expanded body rendered below the row when isExpanded is true. */
  renderExpanded?: (item: T) => ReactNode;
  /** Lines the expanded body will occupy. The shell budgets viewport space
   *  with this so the expanded row + body never push the header off-screen.
   *  Default 0 — implement when `renderExpanded` is set. */
  getExpandedHeight?: (item: T) => number;
  /** In-app search predicate. */
  matches: (item: T, needle: string) => boolean;
  /** Optional aggregate footer rendered above the keybindings hint. */
  summary?: ReactNode;
  /** Optional override for the "no results" empty state. */
  emptyMessage?: string;
}

/**
 * Alternate-screen list browser shell. The type-specific behavior lives in the
 * `adapter` — this component owns terminal dimensions, the edge-scroll window,
 * cursor / search / expand state, key dispatch, and the header/footer chrome.
 *
 * Render strategy: a memoized `Row` short-circuits when its props (a single
 * pre-composed string + an optional expanded node) are unchanged. Combined
 * with the edge-scroll window, most cursor moves only invalidate the two
 * rows whose `isCursor` flag flipped.
 */
export function ListBrowser<T>({ adapter }: { adapter: ListBrowserAdapter<T> }) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [cols, setCols] = useState<number>(() => stdout?.columns ?? 100);
  const [rows, setRows] = useState<number>(() => stdout?.rows ?? 24);
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => {
      setCols(stdout.columns ?? 100);
      setRows(stdout.rows ?? 24);
    };
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  const [search, setSearch] = useState<string>("");
  const [searchMode, setSearchMode] = useState<boolean>(false);
  const [cursor, setCursor] = useState<number>(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState<number>(0);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return adapter.items;
    return adapter.items.filter(item => adapter.matches(item, needle));
  }, [adapter, search]);

  const viewportSize = Math.max(5, rows - RESERVED_LINES);

  // When a row is expanded, its body steals N lines from the visible list. Shrink
  // the slice so the total rendered height (header + N collapsed + expanded body
  // + footer) never exceeds the terminal.
  const expandedItem = expandedId != null
    ? filtered.find(item => adapter.getId(item) === expandedId) ?? null
    : null;
  const expandedHeight = expandedItem && adapter.getExpandedHeight
    ? adapter.getExpandedHeight(expandedItem)
    : 0;
  const effectiveViewportSize = Math.max(1, viewportSize - expandedHeight);

  // Keep cursor inside the filtered range when the list shrinks.
  useEffect(() => {
    if (cursor > 0 && cursor >= filtered.length) {
      setCursor(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, cursor]);

  // Edge-scroll: only nudge the window when the cursor escapes it.
  useEffect(() => {
    setScrollOffset(prev => {
      if (filtered.length === 0) return 0;
      const maxOffset = Math.max(0, filtered.length - effectiveViewportSize);
      let next = prev;
      if (cursor < next) next = cursor;
      else if (cursor >= next + effectiveViewportSize) next = cursor - effectiveViewportSize + 1;
      return Math.min(next, maxOffset);
    });
  }, [cursor, effectiveViewportSize, filtered.length]);

  useInput((input, key) => {
    if (searchMode) {
      if (key.return || key.escape) { setSearchMode(false); return; }
      if (key.backspace || key.delete) { setSearch(prev => prev.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setSearch(prev => prev + input);
      return;
    }

    if (input === "q" || key.escape) { exit(); return; }
    if (input === "/")                 { setSearchMode(true); return; }

    const last = Math.max(0, filtered.length - 1);
    const move = (delta: number): void => {
      setExpandedId(null);
      setCursor(c => Math.max(0, Math.min(last, c + delta)));
    };

    if (key.upArrow   || input === "k") { move(-1); return; }
    if (key.downArrow || input === "j") { move(1);  return; }
    if (key.pageUp)                     { move(-viewportSize); return; }
    if (key.pageDown)                   { move(viewportSize);  return; }
    if (input === "g")                  { setExpandedId(null); setCursor(0);    return; }
    if (input === "G")                  { setExpandedId(null); setCursor(last); return; }
    if (key.return) {
      const item = filtered[cursor];
      if (item) {
        const id = adapter.getId(item);
        setExpandedId(prev => prev === id ? null : id);
      }
      return;
    }
  });

  const ruleWidth = Math.min(cols, 120);
  const visibleEnd = Math.min(filtered.length, scrollOffset + effectiveViewportSize);
  const visible = filtered.slice(scrollOffset, visibleEnd);

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{adapter.title}</Text>
        <Text dimColor>{`  ·  ${filtered.length} results`}</Text>
        {adapter.filterSummary ? <Text dimColor>{`  ·  ${adapter.filterSummary}`}</Text> : null}
        {filtered.length > viewportSize ? (
          <Text dimColor>{`  ·  ${Math.min(cursor + 1, filtered.length)}/${filtered.length}`}</Text>
        ) : null}
      </Text>
      <Text dimColor>{"─".repeat(ruleWidth)}</Text>

      {filtered.length === 0 ? (
        <Text color="yellow">{adapter.emptyMessage ?? "No results match the current filter."}</Text>
      ) : (
        <Box flexDirection="column">
          {visible.map((item, i) => {
            const idx = scrollOffset + i;
            const isCursor = idx === cursor;
            const id = adapter.getId(item);
            const isExpanded = expandedId === id;
            const rendered = adapter.renderRow(item, { isCursor, isExpanded, cols });
            const expandedBody = isExpanded && adapter.renderExpanded
              ? adapter.renderExpanded(item)
              : null;
            return <Row key={id} rendered={rendered} expandedBody={expandedBody} />;
          })}
        </Box>
      )}

      <Text dimColor>{"─".repeat(ruleWidth)}</Text>
      {adapter.summary ? <Box>{adapter.summary}</Box> : null}
      {searchMode ? (
        <Text>
          <Text color="cyan">/ </Text>
          {search}
          <Text color="cyan">_</Text>
          <Text dimColor>  (Enter/Esc to apply)</Text>
        </Text>
      ) : (
        <Text dimColor>
          {`↑↓ navigate · Enter expand · / search${search ? `  (filter: "${search}")` : ""}  · q quit`}
        </Text>
      )}
    </Box>
  );
}

const Row = memo(function Row({
  rendered,
  expandedBody,
}: { rendered: string; expandedBody: ReactNode | null }) {
  return (
    <Box flexDirection="column">
      <Text>{rendered}</Text>
      {expandedBody}
    </Box>
  );
});
