import { useEffect, useState } from "react";
import { Box, Text, useStdout } from "ink";
import Spinner from "ink-spinner";

/**
 * Events the CLI publishes into the dashboard. The CLI subscribes to the
 * scanner's ScanProgress sink and routes per-chunk ticks here via chunkLookup.
 */
export type CurrentPhase = "parse" | "clarify" | "done";

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
  | { type: "phase-set"; phase: CurrentPhase };

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
}

export function ScanDashboard(props: Props) {
  const rows = useFileGroups(props.controller, props.files);
  const phase = usePhase(props.controller);
  const ruleWidth = useRuleWidth();

  return (
    <Box flexDirection="column">
      <Header phase={phase} />
      <AttachmentLine info={props.attachment} />
      <Box marginTop={1}>
        <ColumnHeader />
      </Box>
      <Divider width={ruleWidth} />
      {Array.from(rows.entries()).map(([fileId, group]) => (
        <FileGroupView key={fileId} group={group} />
      ))}
      <Divider width={ruleWidth} />
    </Box>
  );
}

function AttachmentLine({ info }: { info: AttachmentInfo }) {
  const detail = info.format === "pdf" ? "pdf (native)" : "png (rasterized)";
  return (
    <Text dimColor>
      sending: {detail} · {info.providerName} · {info.modelName}
    </Text>
  );
}

function usePhase(controller: ScanDashboardController): CurrentPhase {
  const [phase, setPhase] = useState<CurrentPhase>("parse");
  useEffect(
    () =>
      controller.subscribe((event) => {
        if (event.type === "phase-set") setPhase(event.phase);
      }),
    [controller],
  );
  return phase;
}

function useRuleWidth(): number {
  const { stdout } = useStdout();
  const [cols, setCols] = useState<number>(() => stdout?.columns ?? 100);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setCols(stdout.columns ?? 100);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return Math.min(cols, 120);
}

type PhaseState = "pending" | "running" | "done";

const PHASE_RENDER: Record<PhaseState, (label: string) => JSX.Element> = {
  pending: (label) => <Text dimColor>{label}</Text>,
  running: (label) => (
    <Text color="yellow">
      <Spinner type="dots" /> {label}
    </Text>
  ),
  done: (label) => <Text color="green">✓ {label}</Text>,
};

const PHASE_ORDER: readonly CurrentPhase[] = ["parse", "clarify", "done"];

function phaseStateOf(
  label: "parse" | "clarify",
  current: CurrentPhase,
): PhaseState {
  const li = PHASE_ORDER.indexOf(label);
  const ci = PHASE_ORDER.indexOf(current);
  if (ci > li) return "done";
  if (ci === li) return "running";
  return "pending";
}

function Header({ phase }: { phase: CurrentPhase }) {
  return (
    <Text>
      <Text bold>Scanner</Text>
      <Text dimColor>{"  ·  "}</Text>
      <Text color="green">✓ decrypt</Text>
      <Text dimColor> -&gt; </Text>
      <Text color="green">✓ chunk</Text>
      <Text dimColor> -&gt; </Text>
      {PHASE_RENDER[phaseStateOf("parse", phase)]("parse")}
      <Text dimColor> -&gt; </Text>
      {PHASE_RENDER[phaseStateOf("clarify", phase)]("clarify")}
    </Text>
  );
}

function ColumnHeader() {
  return (
    <Box flexDirection="row">
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

function Divider({ width }: { width: number }) {
  return <Text dimColor>{"─".repeat(width)}</Text>;
}

type FileStatus = "scanning" | "done" | "failed" | "partial";
type AnyStatus = ChunkStatus | FileStatus;

const spin = (label: string) => () => (
  <Text color="yellow">
    <Spinner type="dots" /> {label}
  </Text>
);

const STATUS_RENDER: Record<AnyStatus, () => JSX.Element> = {
  queued: () => <Text color="gray">queued</Text>,
  running: spin("running"),
  scanning: spin("scanning"),
  done: () => <Text color="green">✓ done</Text>,
  failed: () => <Text color="red">failed</Text>,
  partial: () => <Text color="yellow">partial</Text>,
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

function FileGroupView({ group }: { group: FileGroupState }) {
  const chunks = Array.from(group.chunks.values()).sort(
    (a, b) => a.pageNumber - b.pageNumber,
  );
  const agg = aggregate(chunks, group.totalChunks);
  const fileName = `> ${truncateMiddle(group.fileName, COL.files - 2)}`;

  return (
    <Box flexDirection="column">
      <Row
        status={<StatusText status={agg.status} />}
        files={<Text dimColor>{fileName}</Text>}
        transactions={agg.totalTx}
        questions={agg.totalQuestions}
      />
      {chunks.map((c) => (
        <ChunkRow key={c.pageNumber} chunk={c} />
      ))}
    </Box>
  );
}

function ChunkRow({ chunk }: { chunk: ChunkRowState }) {
  const connector = "|-";
  return (
    <Row
      status={<StatusText status={chunk.status} />}
      files={<Text dimColor>{`  ${connector} part ${chunk.pageNumber}`}</Text>}
      transactions={chunk.txCount}
      questions={chunk.questionsCount}
    />
  );
}

function StatusText({ status }: { status: AnyStatus }) {
  return STATUS_RENDER[status]();
}

function Row({
  status,
  files,
  transactions,
  questions,
}: {
  status: JSX.Element;
  files: JSX.Element;
  transactions: number;
  questions: number;
}) {
  return (
    <Box flexDirection="row">
      <Box width={COL.status}>{status}</Box>
      <Box width={COL.files}>{files}</Box>
      <Box width={COL.transactions}>
        <Numeric n={transactions} />
      </Box>
      <Box width={COL.questions}>
        <Numeric n={questions} />
      </Box>
    </Box>
  );
}

type NumericState = "present" | "empty";

const NUMERIC_RULES: readonly Rule<NumericState, number>[] = [
  { when: (n) => n > 0, state: "present" },
  { when: () => true, state: "empty" },
];

const NUMERIC_RENDER: Record<NumericState, (n: number) => JSX.Element> = {
  present: (n) => <Text>{n}</Text>,
  empty: () => (
    <Text color="gray" dimColor>
      -
    </Text>
  ),
};

function Numeric({ n }: { n: number }) {
  return NUMERIC_RENDER[classify(n, NUMERIC_RULES)](n);
}

function truncateMiddle(s: string, width: number): string {
  if (s.length <= width) return s;
  const keep = width - 1;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return s.slice(0, left) + "..." + s.slice(s.length - right);
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

type RowEventKey = Exclude<DashboardEvent["type"], "phase-set">;
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
  if (event.type === "phase-set") return false;
  const chunk = rows.get(event.fileId)?.chunks.get(event.pageNumber);
  if (!chunk) return false;
  const reducer = REDUCERS[event.type] as EventReducer<
    Exclude<DashboardEvent["type"], "phase-set">
  >;
  return reducer(event, chunk);
}
