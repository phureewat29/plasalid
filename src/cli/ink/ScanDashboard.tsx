import { memo, useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import chalk from "chalk";
import { padRight, truncateMiddle } from "../helper.js";
import { ListBrowser, type ListBrowserAdapter } from "./ListBrowser.js";
import { keyOf } from "./keys.js";

/**
 * Events the CLI publishes into the dashboard. The CLI subscribes to the
 * scanner's ScanProgress sink and routes per-chunk ticks here via chunkLookup.
 */
export type CurrentStage = "parse" | "clarify" | "cancelling" | "done";

export type DashboardEvent =
  | {
      type: "chunk-start";
      fileId: string;
      fileName: string;
      pageNumber: number;
      totalPages: number;
    }
  | { type: "chunk-tx"; fileId: string; pageNumber: number }
  | { type: "chunk-question"; fileId: string; pageNumber: number }
  | { type: "chunk-end"; fileId: string; pageNumber: number; ok: boolean }
  | { type: "stage-set"; stage: CurrentStage };

export interface ScanDashboardController {
  publish(event: DashboardEvent): void;
  subscribe(handler: (e: DashboardEvent) => void): () => void;
}

export function createScanDashboardController(): ScanDashboardController {
  const subscribers = new Set<(e: DashboardEvent) => void>();
  return {
    publish(event) {
      for (const sub of subscribers) sub(event);
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
  };
}

type Rule<S, I> = { when: (input: I) => boolean; state: S };

/** First matching rule wins. The final rule should be a catch-all. */
function classify<S, I>(input: I, rules: readonly Rule<S, I>[]): S {
  for (const r of rules) if (r.when(input)) return r.state;
  throw new Error("classify: no rule matched (missing catch-all?)");
}

type ChunkStatus = "queued" | "running" | "done" | "failed";

interface ChunkRowState {
  readonly pageNumber: number;
  status: ChunkStatus;
  txCount: number;
  questionsCount: number;
}

interface FileGroupState {
  readonly fileName: string;
  readonly totalChunks: number;
  chunks: Map<number, ChunkRowState>;
}

const COL = {
  marker: 2, // "▸ " or "  "
  status: 14,
  files: 34,
  transactions: 13,
  questions: 10,
} as const;

export interface FileSeed {
  readonly fileId: string;
  readonly fileName: string;
  readonly totalPages: number;
}

export interface AttachmentInfo {
  format: "pdf" | "png";
  providerName: string;
  modelName: string;
}

interface Props {
  controller: ScanDashboardController;
  files: ReadonlyArray<FileSeed>;
  attachment: AttachmentInfo;
  onCancel: () => void;
}

interface FileItem {
  readonly fileId: string;
  readonly group: FileGroupState;
}

export function ScanDashboard(props: Props) {
  const rows = useFileGroups(props.controller, props.files);
  const stage = useStage(props.controller);
  const spinnerFrame = useSpinnerFrame();

  const items = useMemo<FileItem[]>(
    () => Array.from(rows.entries(), ([fileId, group]) => ({ fileId, group })),
    [rows],
  );

  const adapter = useMemo<ListBrowserAdapter<FileItem>>(
    () => ({
      headerNode: (
        <Box flexDirection="column">
          <Header stage={stage} />
          <AttachmentLine info={props.attachment} />
          <ColumnHeader />
        </Box>
      ),
      items,
      getId: (i) => i.fileId,
      renderRow: (i, ctx) =>
        renderFileRow(
          i.group,
          ctx.isCursor,
          ctx.isExpanded,
          spinnerFrame,
          stage,
        ),
      renderExpanded: (i) => (
        <ChunkList chunks={i.group.chunks} frame={spinnerFrame} />
      ),
      getExpandedHeight: (i) => i.group.chunks.size,
      matches: (i, needle) => i.group.fileName.toLowerCase().includes(needle),
      summary: stage !== "done" ? <Footnote /> : null,
      onKey: (input, key) => {
        const k = keyOf(input, key);
        if (k !== "q" && k !== "escape") return false;
        // Consume the key (return true) so ListBrowser's default `exit` never
        // runs — that would only unmount the UI while the scan kept going.
        props.onCancel();
        return true;
      },
      emptyMessage: "No files in the scan queue.",
    }),
    [stage, items, props.attachment, props.onCancel, spinnerFrame],
  );

  return <ListBrowser adapter={adapter} />;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useSpinnerFrame(): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setI((prev) => (prev + 1) % SPINNER_FRAMES.length),
      80,
    );
    return () => clearInterval(id);
  }, []);
  return SPINNER_FRAMES[i];
}

function Footnote() {
  return (
    <Box flexDirection="column">
      <Text dimColor>
        Output accuracy depends on the model's vision capability.
      </Text>
      <Text>
        <Text dimColor>You can run </Text>
        <Text color="cyan">clarify</Text>
        <Text dimColor>, </Text>
        <Text color="cyan">record</Text>
        <Text dimColor>, and </Text>
        <Text color="cyan">chat</Text>
        <Text dimColor> to correct the data later.</Text>
      </Text>
      <Text></Text>
    </Box>
  );
}

function AttachmentLine({ info }: { info: AttachmentInfo }) {
  const detail = info.format === "pdf" ? "pdf (native)" : "png (rasterized)";
  return (
    <Text dimColor>
      sending: {detail} ({info.providerName}/{info.modelName})
    </Text>
  );
}

function useStage(controller: ScanDashboardController): CurrentStage {
  const [stage, setStage] = useState<CurrentStage>("parse");
  useEffect(
    () =>
      controller.subscribe((event) => {
        if (event.type === "stage-set") setStage(event.stage);
      }),
    [controller],
  );
  return stage;
}

type StageState = "pending" | "running" | "done";

const STAGE_RENDER: Record<StageState, (label: string) => JSX.Element> = {
  pending: (label) => <Text dimColor>{label}</Text>,
  running: (label) => (
    <Text color="yellow">
      <Spinner type="dots" /> {label}
    </Text>
  ),
  done: (label) => <Text color="green">✓ {label}</Text>,
};

const STAGE_ORDER: readonly CurrentStage[] = ["parse", "clarify", "done"];

function stageStateOf(
  label: "parse" | "clarify",
  current: CurrentStage,
): StageState {
  const li = STAGE_ORDER.indexOf(label);
  const ci = STAGE_ORDER.indexOf(current);
  if (ci > li) return "done";
  if (ci === li) return "running";
  return "pending";
}

function Header({ stage }: { stage: CurrentStage }) {
  if (stage === "cancelling") {
    return (
      <Text>
        <Text bold>Scanner</Text>
        <Text dimColor>{"  ·  "}</Text>
        <Text color="green">✓ decrypt</Text>
        <Text dimColor> -&gt; </Text>
        <Text color="green">✓ chunk</Text>
        <Text dimColor> -&gt; </Text>
        <Text color="red">
          <Spinner type="dots" /> cancelling…
        </Text>
      </Text>
    );
  }
  return (
    <Text>
      <Text bold>Scanner</Text>
      <Text dimColor>{"  ·  "}</Text>
      <Text color="green">✓ decrypt</Text>
      <Text dimColor> -&gt; </Text>
      <Text color="green">✓ chunk</Text>
      <Text dimColor> -&gt; </Text>
      {STAGE_RENDER[stageStateOf("parse", stage)]("parse")}
      <Text dimColor> -&gt; </Text>
      {STAGE_RENDER[stageStateOf("clarify", stage)]("clarify")}
    </Text>
  );
}

function ColumnHeader() {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box width={COL.marker} />
      <Box width={COL.status}>
        <Text dimColor>status</Text>
      </Box>
      <Box width={COL.files}>
        <Text dimColor>files</Text>
      </Box>
      <Box width={COL.transactions}>
        <Text dimColor>transactions</Text>
      </Box>
      <Box width={COL.questions}>
        <Text dimColor>questions</Text>
      </Box>
    </Box>
  );
}

type FileStatus = "scanning" | "clarify" | "done" | "failed" | "partial";
type AnyStatus = ChunkStatus | FileStatus;

function statusText(status: AnyStatus, frame: string): string {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return `${frame} running`;
    case "scanning":
      return `${frame} scanning`;
    case "clarify":
      return `${frame} clarify`;
    case "done":
      return "✓ done";
    case "failed":
      return "failed";
    case "partial":
      return "partial";
  }
}

const STATUS_COLOR: Record<AnyStatus, (s: string) => string> = {
  queued: chalk.gray,
  running: chalk.yellow,
  scanning: chalk.yellow,
  clarify: chalk.yellow,
  done: chalk.green,
  failed: chalk.red,
  partial: chalk.yellow,
};

interface FileAggregate {
  totalTx: number;
  totalQuestions: number;
  status: FileStatus;
}

type FileStatusInput = { finished: number; failed: number; total: number };

const FILE_STATUS_RULES: readonly Rule<FileStatus, FileStatusInput>[] = [
  { when: ({ finished, total }) => finished < total, state: "scanning" },
  { when: ({ failed }) => failed === 0, state: "done" },
  { when: ({ failed, total }) => failed === total, state: "failed" },
  { when: () => true, state: "partial" },
];

function aggregate(
  chunks: readonly ChunkRowState[],
  total: number,
): FileAggregate {
  let done = 0,
    failed = 0,
    totalTx = 0,
    totalQuestions = 0;
  for (const c of chunks) {
    if (c.status === "done") done++;
    else if (c.status === "failed") failed++;
    totalTx += c.txCount;
    totalQuestions += c.questionsCount;
  }
  const status = classify(
    { finished: done + failed, failed, total },
    FILE_STATUS_RULES,
  );
  return { totalTx, totalQuestions, status };
}

function renderFileRow(
  group: FileGroupState,
  isCursor: boolean,
  isExpanded: boolean,
  frame: string,
  stage: CurrentStage,
): string {
  const chunks = Array.from(group.chunks.values());
  const agg = aggregate(chunks, group.totalChunks);
  const effectiveStatus: AnyStatus =
    stage === "clarify" ? "clarify" : agg.status;
  const marker = isExpanded ? "▾" : isCursor ? "▸" : " ";

  const status = STATUS_COLOR[effectiveStatus](
    padRight(statusText(effectiveStatus, frame), COL.status),
  );

  const nameRaw = truncateMiddle(group.fileName, COL.files - 2);
  const namePadded = padRight(nameRaw, COL.files);
  const name = isCursor ? chalk.cyan.bold(namePadded) : chalk.dim(namePadded);

  const tx = renderCount(agg.totalTx, COL.transactions);
  const q = renderCount(agg.totalQuestions, COL.questions);

  return `${marker} ${status}${name}${tx}${q}`;
}

function renderCount(n: number, width: number): string {
  const raw = n > 0 ? String(n) : "-";
  const padded = padRight(raw, width);
  return n > 0 ? padded : chalk.gray(padded);
}

const ChunkList = memo(function ChunkList({
  chunks,
  frame,
}: {
  chunks: Map<number, ChunkRowState>;
  frame: string;
}) {
  const sorted = Array.from(chunks.values()).sort(
    (a, b) => a.pageNumber - b.pageNumber,
  );
  return (
    <Box flexDirection="column">
      {sorted.map((c) => (
        <Text key={c.pageNumber}>{renderChunkLine(c, frame)}</Text>
      ))}
    </Box>
  );
});

function renderChunkLine(c: ChunkRowState, frame: string): string {
  const status = STATUS_COLOR[c.status](
    padRight(statusText(c.status, frame), COL.status),
  );
  const part = chalk.dim(padRight(`  |- part ${c.pageNumber}`, COL.files));
  const tx = renderCount(c.txCount, COL.transactions);
  const q = renderCount(c.questionsCount, COL.questions);
  return `  ${status}${part}${tx}${q}`;
}

function useFileGroups(
  controller: ScanDashboardController,
  files: ReadonlyArray<FileSeed>,
) {
  const [rows, setRows] = useState<Map<string, FileGroupState>>(() =>
    seedRows(files),
  );

  useEffect(() => {
    return controller.subscribe((event) => {
      setRows((prev) => {
        const changed = applyDashboardEvent(prev, event);
        return changed ? new Map(prev) : prev;
      });
    });
  }, [controller]);

  return rows;
}

function seedRows(files: ReadonlyArray<FileSeed>): Map<string, FileGroupState> {
  const seed = new Map<string, FileGroupState>();
  for (const f of files) {
    const chunks = new Map<number, ChunkRowState>();
    for (let p = 1; p <= f.totalPages; p++) {
      chunks.set(p, {
        pageNumber: p,
        status: "queued",
        txCount: 0,
        questionsCount: 0,
      });
    }
    seed.set(f.fileId, {
      fileName: f.fileName,
      totalChunks: f.totalPages,
      chunks,
    });
  }
  return seed;
}

type RowEventKey = Exclude<DashboardEvent["type"], "stage-set">;
type EventOf<K extends RowEventKey> = Extract<DashboardEvent, { type: K }>;
type EventReducer<K extends RowEventKey> = (
  event: EventOf<K>,
  chunk: ChunkRowState,
) => boolean;

const REDUCERS: { [K in RowEventKey]: EventReducer<K> } = {
  "chunk-start": (_event, chunk) => {
    if (chunk.status !== "queued") return false;
    chunk.status = "running";
    return true;
  },
  "chunk-tx": (_event, chunk) => {
    chunk.txCount++;
    return true;
  },
  "chunk-question": (_event, chunk) => {
    chunk.questionsCount++;
    return true;
  },
  "chunk-end": (event, chunk) => {
    if (TERMINAL_STATUSES.includes(chunk.status)) return false;
    chunk.status = event.ok ? "done" : "failed";
    return true;
  },
};

const TERMINAL_STATUSES: readonly ChunkStatus[] = ["done", "failed"];

function applyDashboardEvent(
  rows: Map<string, FileGroupState>,
  event: DashboardEvent,
): boolean {
  if (event.type === "stage-set") return false;
  const chunk = rows.get(event.fileId)?.chunks.get(event.pageNumber);
  if (!chunk) return false;
  const reducer = REDUCERS[event.type] as EventReducer<
    Exclude<DashboardEvent["type"], "stage-set">
  >;
  return reducer(event, chunk);
}
