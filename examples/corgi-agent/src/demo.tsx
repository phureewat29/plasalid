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
  costUsd?: number;
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
      costUsd: result.costUsd,
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
    stepStart(_id, _label) {
      // Piped output is a linear log: only completed steps print a line.
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
  answer: string;
  status: "running" | "ok" | "fail";
  startedAt: number;
  plasalidCalls: number;
  durationMs?: number;
  costUsd?: number;
  stderrTail: string[];
}

interface UiState {
  steps: StepRow[];
  activeTurn: TurnData | null;
  turnHistory: TurnData[];
  infoLines: string[];
  /** Updated once per TICK while anything is running; drives spinner/elapsed rendering. */
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
  | { type: "TURN_DELTA"; turn: number; text: string }
  | { type: "TURN_ANSWER"; turn: number; text: string }
  | { type: "TURN_STDERR"; turn: number; lines: string[] }
  | { type: "TURN_DONE"; turn: number; ok: boolean; durationMs?: number; costUsd?: number; plasalidCalls: number }
  | { type: "INFO"; line: string }
  | { type: "TICK" }
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
    case "TURN_DELTA":
      if (!state.activeTurn || state.activeTurn.turn !== action.turn) return state;
      return {
        ...state,
        activeTurn: { ...state.activeTurn, streamingText: state.activeTurn.streamingText + action.text },
      };
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
        costUsd: action.costUsd,
        plasalidCalls: action.plasalidCalls,
      };
      return { ...state, activeTurn: null, turnHistory: [...state.turnHistory, finished] };
    }
    case "INFO":
      return { ...state, infoLines: [...state.infoLines, action.line] };
    case "TICK":
      return { ...state, now: Date.now() };
    case "FINAL":
      return { ...state, done: true, pass: action.pass };
    default:
      return state;
  }
}

function makeInkReporter(dispatch: Dispatch<UiAction>): Reporter {
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
      dispatch({ type: "TURN_DELTA", turn, text });
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
        costUsd: summary.costUsd,
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

/** e.g. "turn 1 done in 84s · 12 plasalid calls · $0.12" (missing fields omitted). */
function turnSummaryText(turn: TurnData): string {
  let head = `turn ${turn.turn} ${turn.status === "ok" ? "done" : "failed"}`;
  if (typeof turn.durationMs === "number") {
    head += ` in ${Math.max(0, Math.round(turn.durationMs / 1000))}s`;
  }
  const extras = [pluralize(turn.plasalidCalls, "plasalid call")];
  if (typeof turn.costUsd === "number") extras.push(`$${turn.costUsd.toFixed(2)}`);
  return `${head} · ${extras.join(" · ")}`;
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

function TurnBlock({ turn, now }: { turn: TurnData; now: number }) {
  const running = turn.status === "running";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{DIVIDER}</Text>
      <Text bold color="cyan">
        🐶 turn {turn.turn}/{turn.total}: {turn.prompt}
      </Text>
      {turn.activity.map((line, i) => (
        <Text key={i} dimColor>
          {line}
        </Text>
      ))}
      {running && turn.streamingText.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {turn.streamingText.split("\n").map((line, i) => (
            <Text key={i} dimColor italic>
              {line.length > 0 ? line : " "}
            </Text>
          ))}
        </Box>
      )}
      {running && (
        <Text>
          <Text color="cyan">
            <Spinner type={SPINNER_TYPE} />
          </Text>{" "}
          <Text color="yellow">elapsed {elapsedSeconds(now, turn.startedAt)}s</Text>
        </Text>
      )}
      {turn.answer.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>answer:</Text>
          {turn.answer.split("\n").map((line, i) => (
            <Text key={i}>{line.length > 0 ? line : " "}</Text>
          ))}
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

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const reporter = makeInkReporter(dispatch);
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

  // Ticks the spinner/elapsed-time displays every 500ms, but only while
  // something is actually running - cleared the instant we go idle/done so
  // a finished run doesn't keep re-rendering.
  const isRunning = state.activeTurn !== null || state.steps.some((s) => s.status === "running");
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => dispatch({ type: "TICK" }), 500);
    return () => clearInterval(id);
  }, [isRunning]);

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        🐶 corgi-agent — plasalid x claude -p
      </Text>
      <Box flexDirection="column" marginTop={1}>
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
