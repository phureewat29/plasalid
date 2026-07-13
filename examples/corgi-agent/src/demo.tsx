/**
 * corgi-agent demo entry point.
 *
 * An external `claude` CLI agent drives the plasalid harness end to end over
 * a real, password-protected Thai credit-card statement, using only the
 * documented `plasalid` CLI surface. See README.md for the full run story.
 *
 * Usage:
 *   npm start --                              full demo (requires the `claude` CLI)
 *   npm start -- --skip-claude                plumbing-only check, no `claude` required
 *   npm start -- --keep-workspace              leave the isolated workspace on disk
 *   npm start -- --turn-timeout <seconds>       per-turn timeout (default 600)
 *
 * Rendering: a TTY stdout gets a live ink dashboard (checklist + streaming
 * turn panes, with tasteful emoji/spinner accents); a piped/non-TTY stdout
 * gets the same information as flat, sequential, plain-text lines. Both
 * paths run the identical `runDemo` orchestration below - only how its
 * Reporter callbacks are rendered differs.
 *
 * UI RULE: the TTY (ink) renderer may use tasteful emoji/spinner/color
 * accents - not confetti. The piped/plain renderer stays pure ASCII: step
 * states render as "[....]" (running), "[ ok ]" (done), "[fail]" (failed);
 * tool activity lines render as "> ...".
 *
 * Render clock: a single interval (TICK_MS, below) drives every
 * spinner/elapsed/streaming-text update in the ink renderer. Streaming
 * deltas are never dispatched as they arrive - they're buffered outside
 * React state (see App's `pendingDeltaRef`) and merged into visible state
 * only on TICK, which itself is a no-op (same state reference, no
 * re-render) whenever nothing a viewer would see has actually changed. See
 * the `uiReducer`'s "TICK" case for the details.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Dispatch, useEffect, useReducer, useRef } from "react";
import { Box, render, Static, Text } from "ink";
import Spinner from "ink-spinner";
import {
  buildEnv,
  buildPlasalid,
  checkClaudeCli,
  cleanupWorkspace,
  createWorkspace,
  installSkill,
  parseNdjson,
  placeStatement,
  runPlasalid,
  vaultAddPassword,
  writeBinShim,
  type WorkspacePaths,
} from "./workspace.js";
import { DEFAULT_TURN_TIMEOUT_SEC, runClaudeTurn } from "./claude-stream.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const STATEMENT_SOURCE = resolve(SCRIPT_DIR, "..", "card-statement-2026-05.pdf");
const STATEMENT_PASSWORD = "corgimoho";
const VAULT_PATTERN = "^card-statement";
const DEMO_TOOLS = "Bash(plasalid:*),Read,Write,Skill";
const DIVIDER = "-".repeat(60);
/** Ink-only spinner style (cli-spinners "dots" - a braille cycle). */
const SPINNER_TYPE = "dots";
/** Plain-mode heartbeat cadence while a turn is running with no other output. */
const HEARTBEAT_MS = 15_000;
/** Single render-clock cadence (ms) for the ink UI: drives BOTH the
 *  elapsed-time ticker and the merge of buffered streaming-answer deltas
 *  into visible state. 250-400ms is fast enough to read as "live" while
 *  guaranteeing no delta chunk, however small or frequent, can itself
 *  trigger a re-render. */
const TICK_MS = 300;
/** A delta is treated as "still writing" (vs. "thinking") while it's this recent. */
const WRITING_WINDOW_MS = 2000;
/** Only the last this-many lines of the live-streaming answer are shown
 *  (dim), with a "… (+N earlier lines)" head marker above them - bounds the
 *  dynamic region's height so ink never redraws a growing-without-limit
 *  area on every merge. */
const STREAMING_TEXT_MAX_LINES = 6;

const TURN_PROMPTS = [
  "ingest my new statements, then give me a quick summary of what you found",
  "resolve any open questions using your own judgment, and capture the card's statement metadata (masked number, points, due day) onto the account",
  "how much did I spend this billed period, what were my top merchants, and what should I watch next month?",
];

const USAGE = `usage: npm start -- [--skip-claude] [--keep-workspace] [--turn-timeout <seconds>]

  --skip-claude      skip the live "claude -p" turns; only check that the
                     ingest pipeline discovers the statement (no claude CLI
                     required)
  --keep-workspace   do not delete the isolated workspace on exit; prints
                     its path instead
  --turn-timeout <seconds>
                     kill a "claude -p" turn (SIGTERM, then SIGKILL 5s later
                     if still alive) if it runs longer than this. Default:
                     ${DEFAULT_TURN_TIMEOUT_SEC}
  -h, --help         show this help text
`;

// small pure helpers

function bracket(status: "running" | "ok" | "fail"): string {
  if (status === "running") return "[....]";
  if (status === "ok") return "[ ok ]";
  return "[fail]";
}

/** First non-blank line of a subprocess's stderr, truncated for display. */
function truncateDetail(s: string, max = 200): string {
  const line = (s.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
  return line.length > max ? `${line.slice(0, Math.max(0, max - 3))}...` : line;
}

/** Safe nested-number lookup into a parsed JSON value (never throws). */
function numberField(obj: unknown, ...path: string[]): number {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return 0;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "number" ? cur : 0;
}

function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// orchestration core - shared verbatim by the ink (TTY) and plain (piped) renderers below via the Reporter interface

interface TurnSummary {
  durationMs?: number;
  plasalidCalls: number;
}

interface Reporter {
  stepStart(id: string, label: string): void;
  stepDone(id: string, label: string, ok: boolean, detail?: string): void;
  turnStart(turn: number, total: number, prompt: string): void;
  turnActivity(turn: number, line: string): void;
  /** A coalesced chunk of the turn's live/optimistic streaming answer text. */
  turnDelta(turn: number, text: string): void;
  turnAnswer(turn: number, text: string): void;
  /** Last (up to) 3 stderr lines from a turn that otherwise succeeded. */
  turnStderr(turn: number, lines: string[]): void;
  turnDone(turn: number, ok: boolean, summary: TurnSummary): void;
  info(line: string): void;
}

interface DemoOptions {
  skipClaude: boolean;
  turnTimeoutSec: number;
}

interface DemoOutcome {
  pass: boolean;
  paths: WorkspacePaths | null;
}

/**
 * Runs the full demo sequence, reporting progress through `report` and
 * returning whether it passed. `onWorkspaceReady` fires the moment the
 * workspace directory exists, so a caller can register it for cleanup before
 * the (potentially long-running) claude turns even start.
 */
async function runDemo(
  opts: DemoOptions,
  report: Reporter,
  onWorkspaceReady: (paths: WorkspacePaths) => void,
): Promise<DemoOutcome> {
  const step = async (
    id: string,
    label: string,
    fn: () => Promise<{ ok: boolean; detail?: string }>,
  ): Promise<boolean> => {
    report.stepStart(id, label);
    let result: { ok: boolean; detail?: string };
    try {
      result = await fn();
    } catch (err) {
      result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    report.stepDone(id, label, result.ok, result.detail);
    return result.ok;
  };

  if (
    !(await step("build", "build plasalid", async () => {
      const res = await buildPlasalid(REPO_ROOT);
      return { ok: res.ok, detail: res.ok ? undefined : `exit ${res.code}: ${truncateDetail(res.stderr)}` };
    }))
  ) {
    return { pass: false, paths: null };
  }

  let paths: WorkspacePaths | null = null;
  const workspaceOk = await step("workspace", "create workspace", async () => {
    paths = createWorkspace();
    onWorkspaceReady(paths);
    return { ok: true, detail: paths.root };
  });
  if (!workspaceOk || !paths) return { pass: false, paths: null };
  const ws: WorkspacePaths = paths;

  const binShimOk = await step("bin-shim", "write bin shim", async () => {
    writeBinShim(ws, REPO_ROOT);
    return { ok: true };
  });
  if (!binShimOk) return { pass: false, paths: ws };

  let env: NodeJS.ProcessEnv = process.env;
  const envOk = await step("isolation-env", "export isolation env", async () => {
    env = buildEnv(ws);
    return { ok: true };
  });
  if (!envOk) return { pass: false, paths: ws };

  const statementOk = await step("place-statement", "place statement", async () => {
    const dest = placeStatement(ws, STATEMENT_SOURCE);
    return { ok: true, detail: dest };
  });
  if (!statementOk) return { pass: false, paths: ws };

  const installOk = await step("install-skill", "install skill", async () => {
    const res = await installSkill(ws, env);
    return {
      ok: res.ok,
      detail: res.ok
        ? `via ${res.command}`
        : `exit ${res.code}: ${truncateDetail(res.stderr)}`,
    };
  });
  if (!installOk) return { pass: false, paths: ws };

  const vaultOk = await step("vault-add", "vault add password", async () => {
    const res = await vaultAddPassword(VAULT_PATTERN, STATEMENT_PASSWORD, env, ws.cwd);
    return { ok: res.ok, detail: res.ok ? undefined : `exit ${res.code}: ${truncateDetail(res.stderr)}` };
  });
  if (!vaultOk) return { pass: false, paths: ws };

  const statusOk = await step("status-check", "status check", async () => {
    const res = await runPlasalid(["status", "--json"], env, ws.cwd);
    return { ok: res.ok, detail: res.ok ? undefined : `exit ${res.code}: ${truncateDetail(res.stderr)}` };
  });
  if (!statusOk) return { pass: false, paths: ws };

  if (opts.skipClaude) {
    const plumbingOk = await step("plumbing", "ingest list plumbing check", async () => {
      const res = await runPlasalid(["ingest", "list", "--json"], env, ws.cwd);
      if (!res.ok) return { ok: false, detail: `exit ${res.code}: ${truncateDetail(res.stderr)}` };

      const objs = parseNdjson(res.stdout);
      const summary = objs.find((o) => o.type === "summary");
      if (!summary) return { ok: false, detail: "no summary line in ingest list --json output" };

      const newCount = summary.new;
      if (!(typeof newCount === "number" && newCount >= 1)) {
        return { ok: false, detail: `expected summary.new >= 1, got ${JSON.stringify(newCount)}` };
      }
      return { ok: true, detail: `${newCount} new file(s) awaiting ingest` };
    });
    return { pass: plumbingOk, paths: ws };
  }

  // Fail fast with a friendly message instead of a raw ENOENT deep inside
  // the first turn's spawn() if `claude` isn't installed/authenticated.
  const preflightOk = await step("preflight", "check claude CLI", async () => {
    const ok = checkClaudeCli(env);
    return {
      ok,
      detail: ok ? undefined : "claude CLI not found or not working - install Claude Code and authenticate",
    };
  });
  if (!preflightOk) return { pass: false, paths: ws };

  for (let i = 0; i < TURN_PROMPTS.length; i++) {
    const turn = i + 1;
    const prompt = TURN_PROMPTS[i];
    report.turnStart(turn, TURN_PROMPTS.length, prompt);

    let plasalidCalls = 0;
    let skillLoaded = false;
    const result = await runClaudeTurn(
      {
        prompt,
        continueSession: turn > 1,
        cwd: ws.cwd,
        env,
        allowedTools: DEMO_TOOLS,
        turnTimeoutSec: opts.turnTimeoutSec,
      },
      (event) => {
        if (event.kind === "activity") report.turnActivity(turn, event.line);
        else if (event.kind === "delta") report.turnDelta(turn, event.text);
        else if (event.kind === "skill") skillLoaded = true;
        else if (event.kind === "plasalid-call") plasalidCalls += 1;
      },
    );

    if (result.stderrTail && result.stderrTail.length > 0) {
      report.turnStderr(turn, result.stderrTail);
    }
    report.turnAnswer(turn, result.answer || "(no answer text)");
    if (turn === 1) {
      report.info(`skill loaded: ${skillLoaded ? "yes" : "no"}`);
    }
    report.turnDone(turn, result.ok, {
      durationMs: result.durationMs,
      plasalidCalls,
    });
    if (!result.ok) return { pass: false, paths: ws };
  }

  const assertionsOk = await step("assertions", "final assertions", async () => {
    const res = await runPlasalid(["status", "--json"], env, ws.cwd);
    if (!res.ok) return { ok: false, detail: `exit ${res.code}: ${truncateDetail(res.stderr)}` };

    const [status] = parseNdjson(res.stdout);
    const scanned = numberField(status, "files", "scanned");
    const transactions = numberField(status, "counts", "transactions");
    if (!(scanned >= 1 && transactions > 0)) {
      return {
        ok: false,
        detail: `expected files.scanned >= 1 and counts.transactions > 0, got scanned=${scanned} transactions=${transactions}`,
      };
    }

    const openQuestions = numberField(status, "questions", "open");
    report.info(`${openQuestions} open question(s) after the demo (informational)`);
    return { ok: true, detail: `files.scanned=${scanned}, counts.transactions=${transactions}` };
  });

  return { pass: assertionsOk, paths: ws };
}

// plain (non-TTY / piped) renderer

function makePlainReporter(): Reporter {
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let turnStartedAt = 0;

  function clearHeartbeat(): void {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }
  /** (Re)arm the heartbeat: fires at most every HEARTBEAT_MS of silence,
   *  then reschedules itself so a long-silent turn keeps reassuring the
   *  user it's still alive. Any real output cancels/rearms this. */
  function scheduleHeartbeat(): void {
    clearHeartbeat();
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      const elapsed = Math.max(0, Math.round((Date.now() - turnStartedAt) / 1000));
      console.log(`... thinking (${elapsed}s)`);
      scheduleHeartbeat();
    }, HEARTBEAT_MS);
  }

  return {
    stepStart(id, _label) {
      // Piped output is a linear log: only completed steps print a line,
      // except for a single blank-line separator ahead of the final
      // assertions step, which otherwise would butt straight up against
      // the last turn's divider.
      if (id === "assertions") console.log("");
    },
    stepDone(_id, label, ok, detail) {
      console.log(`${bracket(ok ? "ok" : "fail")} ${label}${detail ? `  ${detail}` : ""}`);
    },
    turnStart(turn, total, prompt) {
      console.log("");
      console.log(DIVIDER);
      console.log(`turn ${turn}/${total}: ${prompt}`);
      turnStartedAt = Date.now();
      scheduleHeartbeat();
    },
    turnActivity(_turn, line) {
      scheduleHeartbeat();
      console.log(line);
    },
    turnDelta(_turn, _text) {
      // Plain mode is a flat ASCII log; live streaming text is an ink-only
      // affordance (see TurnBlock in the TTY renderer below).
    },
    turnAnswer(_turn, text) {
      scheduleHeartbeat();
      console.log("");
      console.log("answer:");
      console.log(text);
    },
    turnStderr(_turn, lines) {
      for (const line of lines) console.log(`stderr: ${line}`);
    },
    turnDone(turn, ok, summary) {
      clearHeartbeat();
      console.log(DIVIDER);
      let line = `turn ${turn} ${ok ? "done" : "failed"}`;
      if (typeof summary.durationMs === "number") {
        line += ` in ${Math.max(0, Math.round(summary.durationMs / 1000))}s`;
      }
      line += ` (${pluralize(summary.plasalidCalls, "plasalid call")})`;
      console.log(line);
    },
    info(line) {
      console.log(line);
    },
  };
}

async function runPlain(opts: DemoOptions): Promise<number> {
  console.log("corgi-agent demo");
  const reporter = makePlainReporter();
  const outcome = await runDemo(opts, reporter, (paths) => {
    currentWorkspacePaths = paths;
  });
  if (outcome.paths) {
    if (keepWorkspaceFlag) reporter.info(`workspace kept at ${outcome.paths.root}`);
  }
  console.log(outcome.pass ? "PASS" : "FAIL");
  return outcome.pass ? 0 : 1;
}

// ink (TTY) renderer

interface StepRow {
  id: string;
  label: string;
  status: "running" | "ok" | "fail";
  detail?: string;
  startedAt: number;
}

interface TurnData {
  turn: number;
  total: number;
  prompt: string;
  activity: string[];
  /** Coalesced live-streaming answer text; cleared once the authoritative answer lands. */
  streamingText: string;
  /** Timestamp of the last TICK that merged non-empty delta text into
   *  `streamingText`, or null if no delta has arrived yet. Drives the
   *  "thinking…" vs "writing…" status word below. */
  lastDeltaAt: number | null;
  answer: string;
  status: "running" | "ok" | "fail";
  startedAt: number;
  plasalidCalls: number;
  durationMs?: number;
  stderrTail: string[];
}

interface UiState {
  steps: StepRow[];
  activeTurn: TurnData | null;
  turnHistory: TurnData[];
  infoLines: string[];
  /** Updated on TICK while anything is running; drives spinner/elapsed rendering. */
  now: number;
  done: boolean;
  pass: boolean;
}

const initialUiState: UiState = {
  steps: [],
  activeTurn: null,
  turnHistory: [],
  infoLines: [],
  now: Date.now(),
  done: false,
  pass: false,
};

type UiAction =
  | { type: "STEP_START"; id: string; label: string }
  | { type: "STEP_DONE"; id: string; ok: boolean; detail?: string }
  | { type: "TURN_START"; turn: number; total: number; prompt: string }
  | { type: "TURN_ACTIVITY"; turn: number; line: string }
  | { type: "TURN_ANSWER"; turn: number; text: string }
  | { type: "TURN_STDERR"; turn: number; lines: string[] }
  | { type: "TURN_DONE"; turn: number; ok: boolean; durationMs?: number; plasalidCalls: number }
  | { type: "INFO"; line: string }
  /** The single render clock. `pendingDelta`/`pendingDeltaTurn` carry any
   *  streaming-answer text buffered since the last TICK (see App's
   *  `pendingDeltaRef`) - merged into the matching active turn's
   *  `streamingText` here, and only here. */
  | { type: "TICK"; now: number; pendingDelta?: string; pendingDeltaTurn?: number }
  | { type: "FINAL"; pass: boolean };

function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "STEP_START": {
      if (state.steps.some((s) => s.id === action.id)) {
        return {
          ...state,
          steps: state.steps.map((s) =>
            s.id === action.id ? { ...s, status: "running", startedAt: Date.now() } : s,
          ),
        };
      }
      return {
        ...state,
        steps: [...state.steps, { id: action.id, label: action.label, status: "running", startedAt: Date.now() }],
      };
    }
    case "STEP_DONE":
      return {
        ...state,
        steps: state.steps.map((s) =>
          s.id === action.id ? { ...s, status: action.ok ? "ok" : "fail", detail: action.detail } : s,
        ),
      };
    case "TURN_START":
      return {
        ...state,
        activeTurn: {
          turn: action.turn,
          total: action.total,
          prompt: action.prompt,
          activity: [],
          streamingText: "",
          lastDeltaAt: null,
          answer: "",
          status: "running",
          startedAt: Date.now(),
          plasalidCalls: 0,
          stderrTail: [],
        },
      };
    case "TURN_ACTIVITY":
      if (!state.activeTurn || state.activeTurn.turn !== action.turn) return state;
      return { ...state, activeTurn: { ...state.activeTurn, activity: [...state.activeTurn.activity, action.line] } };
    case "TURN_ANSWER":
      if (!state.activeTurn || state.activeTurn.turn !== action.turn) return state;
      return { ...state, activeTurn: { ...state.activeTurn, answer: action.text, streamingText: "" } };
    case "TURN_STDERR":
      if (!state.activeTurn || state.activeTurn.turn !== action.turn) return state;
      return { ...state, activeTurn: { ...state.activeTurn, stderrTail: action.lines } };
    case "TURN_DONE": {
      if (!state.activeTurn || state.activeTurn.turn !== action.turn) return state;
      const finished: TurnData = {
        ...state.activeTurn,
        status: action.ok ? "ok" : "fail",
        durationMs: action.durationMs,
        plasalidCalls: action.plasalidCalls,
      };
      return { ...state, activeTurn: null, turnHistory: [...state.turnHistory, finished] };
    }
    case "INFO":
      return { ...state, infoLines: [...state.infoLines, action.line] };
    case "TICK": {
      const hasPendingDelta =
        typeof action.pendingDelta === "string" &&
        action.pendingDelta.length > 0 &&
        state.activeTurn != null &&
        state.activeTurn.turn === action.pendingDeltaTurn;

      const runningStepsChanged = state.steps.some(
        (s) =>
          s.status === "running" &&
          elapsedSeconds(state.now, s.startedAt) !== elapsedSeconds(action.now, s.startedAt),
      );
      const activeTurnSecondsChanged =
        state.activeTurn != null &&
        elapsedSeconds(state.now, state.activeTurn.startedAt) !==
          elapsedSeconds(action.now, state.activeTurn.startedAt);

      if (!hasPendingDelta && !runningStepsChanged && !activeTurnSecondsChanged) {
        // Nothing a viewer would see has changed - return the SAME
        // reference so React bails out of re-rendering entirely.
        return state;
      }

      return {
        ...state,
        now: action.now,
        activeTurn:
          state.activeTurn && hasPendingDelta
            ? {
                ...state.activeTurn,
                streamingText: state.activeTurn.streamingText + action.pendingDelta,
                lastDeltaAt: action.now,
              }
            : state.activeTurn,
      };
    }
    case "FINAL":
      return { ...state, done: true, pass: action.pass };
    default:
      return state;
  }
}

function makeInkReporter(
  dispatch: Dispatch<UiAction>,
  appendPendingDelta: (turn: number, text: string) => void,
): Reporter {
  return {
    stepStart(id, label) {
      dispatch({ type: "STEP_START", id, label });
    },
    stepDone(id, _label, ok, detail) {
      dispatch({ type: "STEP_DONE", id, ok, detail });
    },
    turnStart(turn, total, prompt) {
      dispatch({ type: "TURN_START", turn, total, prompt });
    },
    turnActivity(turn, line) {
      dispatch({ type: "TURN_ACTIVITY", turn, line });
    },
    turnDelta(turn, text) {
      // Buffered outside React state - see App's pendingDeltaRef and the
      // render-clock note at the top of this file. Never dispatched
      // directly, so however fast/often deltas arrive, no re-render fires
      // until the next TICK merges the buffer in.
      appendPendingDelta(turn, text);
    },
    turnAnswer(turn, text) {
      dispatch({ type: "TURN_ANSWER", turn, text });
    },
    turnStderr(turn, lines) {
      dispatch({ type: "TURN_STDERR", turn, lines });
    },
    turnDone(turn, ok, summary) {
      dispatch({
        type: "TURN_DONE",
        turn,
        ok,
        durationMs: summary.durationMs,
        plasalidCalls: summary.plasalidCalls,
      });
    },
    info(line) {
      dispatch({ type: "INFO", line });
    },
  };
}

function elapsedSeconds(now: number, startedAt: number): number {
  return Math.max(0, Math.round((now - startedAt) / 1000));
}

/** e.g. "turn 1 done in 84s · 12 plasalid calls" (missing duration omitted). */
function turnSummaryText(turn: TurnData): string {
  let head = `turn ${turn.turn} ${turn.status === "ok" ? "done" : "failed"}`;
  if (typeof turn.durationMs === "number") {
    head += ` in ${Math.max(0, Math.round(turn.durationMs / 1000))}s`;
  }
  return `${head} · ${pluralize(turn.plasalidCalls, "plasalid call")}`;
}

function StepRowView({ step, now }: { step: StepRow; now: number }) {
  if (step.status === "running") {
    return (
      <Text>
        <Text color="cyan">
          <Spinner type={SPINNER_TYPE} />
        </Text>{" "}
        {step.label} <Text color="yellow">elapsed {elapsedSeconds(now, step.startedAt)}s</Text>
      </Text>
    );
  }
  const ok = step.status === "ok";
  return (
    <Text>
      <Text color={ok ? "green" : "red"}>{ok ? "✅" : "❌"}</Text> {step.label}
      {step.detail ? `  ${step.detail}` : ""}
    </Text>
  );
}

/** Bounded live-streaming answer region - see STREAMING_TEXT_MAX_LINES. */
function StreamingTextView({ text }: { text: string }) {
  const lines = text.split("\n");
  const hiddenCount = Math.max(0, lines.length - STREAMING_TEXT_MAX_LINES);
  const visibleLines = lines.slice(-STREAMING_TEXT_MAX_LINES);
  return (
    <Box flexDirection="column" marginTop={1}>
      {hiddenCount > 0 && <Text dimColor>… (+{hiddenCount} earlier lines)</Text>}
      {visibleLines.map((line, i) => (
        <Text key={i} dimColor italic>
          {line.length > 0 ? line : " "}
        </Text>
      ))}
    </Box>
  );
}

function TurnBlock({ turn, now }: { turn: TurnData; now: number }) {
  const running = turn.status === "running";
  const writing = turn.lastDeltaAt != null && now - turn.lastDeltaAt <= WRITING_WINDOW_MS;
  return (
    <Box flexDirection="column" marginY={1}>
      <Text dimColor>{DIVIDER}</Text>
      <Text bold color="cyan">
        🐶 turn {turn.turn}/{turn.total}: {turn.prompt}
      </Text>
      {turn.activity.map((line, i) => (
        <Text key={i} dimColor>
          {line}
        </Text>
      ))}
      {running && turn.streamingText.length > 0 && <StreamingTextView text={turn.streamingText} />}
      {/* Status row: ALWAYS its own Box (own line, marginTop for visual
          separation), ALWAYS the last thing in the running turn's dynamic
          area (right before the answer/summary section, which are empty
          while running) - never inline with activity or streaming-text
          lines, never re-ordered relative to its siblings. Three separate
          Text children (spinner / status word / elapsed) so ink diffs each
          piece independently instead of repainting one merged string. */}
      {running && (
        <Box marginTop={1}>
          <Text color="cyan">
            <Spinner type={SPINNER_TYPE} />
          </Text>
          <Text> {writing ? "writing" : "thinking"}… </Text>
          <Text color="yellow">{elapsedSeconds(now, turn.startedAt)}s</Text>
        </Box>
      )}
      {turn.answer.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>answer:</Text>
          <Box flexDirection="column" paddingLeft={2}>
            {turn.answer.split("\n").map((line, i) => (
              <Text key={i}>{line.length > 0 ? line : " "}</Text>
            ))}
          </Box>
        </Box>
      )}
      {turn.stderrTail.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {turn.stderrTail.map((line, i) => (
            <Text key={i} dimColor>
              stderr: {line}
            </Text>
          ))}
        </Box>
      )}
      {!running && (
        <Text bold color={turn.status === "ok" ? "green" : "red"}>
          {turn.status === "ok" ? "✅" : "❌"} {turnSummaryText(turn)}
        </Text>
      )}
      <Text dimColor>{DIVIDER}</Text>
    </Box>
  );
}

function App({ opts, onExit }: { opts: DemoOptions; onExit: (code: number) => void }) {
  const [state, dispatch] = useReducer(uiReducer, initialUiState);
  const startedRef = useRef(false);
  /** Streaming-answer text buffered outside React state since the last
   *  TICK - see the render-clock note at the top of this file. Appending
   *  here never dispatches, so however fast/often deltas arrive, no
   *  re-render is triggered until the next TICK merges the buffer in. */
  const pendingDeltaRef = useRef<{ turn: number; text: string } | null>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const reporter = makeInkReporter(dispatch, (turn, text) => {
      const cur = pendingDeltaRef.current;
      pendingDeltaRef.current = cur && cur.turn === turn ? { turn, text: cur.text + text } : { turn, text };
    });
    (async () => {
      const outcome = await runDemo(opts, reporter, (paths) => {
        currentWorkspacePaths = paths;
      });
      if (outcome.paths && keepWorkspaceFlag) {
        reporter.info(`workspace kept at ${outcome.paths.root}`);
      }
      dispatch({ type: "FINAL", pass: outcome.pass });
      // Give ink one tick to flush the final render (including Static
      // content) before the process exits.
      setTimeout(() => onExit(outcome.pass ? 0 : 1), 50);
    })();
  }, [opts, onExit]);

  // The single render clock: ticks the spinner/elapsed-time/streaming-text
  // displays every TICK_MS, but only while something is actually running -
  // cleared the instant we go idle/done so a finished run doesn't keep
  // re-rendering. uiReducer's TICK case further bails out (same state
  // reference, no re-render) on any given tick where nothing visible
  // actually changed.
  const isRunning = state.activeTurn !== null || state.steps.some((s) => s.status === "running");
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => {
      const pending = pendingDeltaRef.current;
      pendingDeltaRef.current = null;
      dispatch({
        type: "TICK",
        now: Date.now(),
        pendingDelta: pending?.text,
        pendingDeltaTurn: pending?.turn,
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [isRunning]);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🐶 corgi-agent — plasalid x claude -p
        </Text>
      </Box>
      <Box flexDirection="column">
        {state.steps.map((s) => (
          <StepRowView key={s.id} step={s} now={state.now} />
        ))}
      </Box>
      <Static items={state.turnHistory}>
        {(turn) => <TurnBlock key={turn.turn} turn={turn} now={state.now} />}
      </Static>
      {state.activeTurn && <TurnBlock turn={state.activeTurn} now={state.now} />}
      {state.infoLines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {state.infoLines.map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}
      {state.done && (
        <Box marginTop={1}>
          <Text bold color={state.pass ? "green" : "red"}>
            {state.pass ? "PASS" : "FAIL"}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function runTty(opts: DemoOptions): Promise<number> {
  return new Promise((resolveExit) => {
    let instance: ReturnType<typeof render>;
    instance = render(
      <App
        opts={opts}
        onExit={(code) => {
          instance.unmount();
          resolveExit(code);
        }}
      />,
    );
  });
}

// process-level workspace cleanup (covers normal exit, --keep-workspace, and SIGINT/SIGTERM mid-run) + argv parsing + main

let currentWorkspacePaths: WorkspacePaths | null = null;
let keepWorkspaceFlag = false;
let cleanedUp = false;

function cleanupOnce(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  if (currentWorkspacePaths && !keepWorkspaceFlag) {
    cleanupWorkspace(currentWorkspacePaths);
  }
}

process.on("exit", cleanupOnce);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (keepWorkspaceFlag && currentWorkspacePaths) {
      process.stderr.write(`\nworkspace kept at ${currentWorkspacePaths.root}\n`);
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

interface CliArgs {
  skipClaude: boolean;
  keepWorkspace: boolean;
  turnTimeoutSec: number;
  help: boolean;
  unknown: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    skipClaude: false,
    keepWorkspace: false,
    turnTimeoutSec: DEFAULT_TURN_TIMEOUT_SEC,
    help: false,
    unknown: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skip-claude") {
      args.skipClaude = true;
    } else if (arg === "--keep-workspace") {
      args.keepWorkspace = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--turn-timeout") {
      const raw = argv[i + 1];
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        args.unknown.push(raw === undefined ? arg : `${arg} ${raw}`);
        if (raw !== undefined) i++; // consume the bad value so it isn't also flagged on its own
      } else {
        args.turnTimeoutSec = parsed;
        i++; // consume the value
      }
    } else {
      args.unknown.push(arg);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.unknown.length > 0) {
    process.stderr.write(`unknown argument(s): ${args.unknown.join(" ")}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  keepWorkspaceFlag = args.keepWorkspace;
  const opts: DemoOptions = { skipClaude: args.skipClaude, turnTimeoutSec: args.turnTimeoutSec };

  const code = process.stdout.isTTY ? await runTty(opts) : await runPlain(opts);
  process.exitCode = code;
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
