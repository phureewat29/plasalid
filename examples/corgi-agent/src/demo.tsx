/**
 * corgi-agent demo entry point.
 *
 * An external `claude` CLI agent drives the plasalid harness end to end over
 * a real, password-protected Thai credit-card statement, using only the
 * documented `plasalid` CLI surface. See README.md for the full run story.
 *
 * Usage:
 *   npm start --                    full demo (requires the `claude` CLI)
 *   npm start -- --skip-claude      plumbing-only check, no `claude` required
 *   npm start -- --keep-workspace   leave the isolated workspace on disk
 *
 * Rendering: a TTY stdout gets a live ink dashboard (checklist + streaming
 * turn panes); a piped/non-TTY stdout gets the exact same information as
 * flat, sequential plain-text lines (see PLAIN vs TTY notes below). Both
 * paths run the identical `runDemo` orchestration below - only how its
 * Reporter callbacks are rendered differs.
 *
 * STRICT UI RULE: pure text only, no emoji/unicode symbols/spinners. Step
 * states render as "[....]" (running), "[ ok ]" (done), "[fail]" (failed);
 * tool activity lines render as "> ...".
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Dispatch, useEffect, useReducer, useRef } from "react";
import { Box, render, Static, Text } from "ink";
import {
  buildEnv,
  buildPlasalid,
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
import { runClaudeTurn } from "./claude-stream.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const STATEMENT_SOURCE = resolve(SCRIPT_DIR, "..", "card-statement-2026-05.pdf");
const STATEMENT_PASSWORD = "corgimoho";
const VAULT_PATTERN = "^card-statement";
const DEMO_TOOLS = "Bash(plasalid:*),Read,Write";
const DIVIDER = "-".repeat(60);

const TURN_PROMPTS = [
  "ingest my new statements, then give me a quick summary of what you found",
  "resolve any open questions using your own judgment, and capture the card's statement metadata (masked number, points, due day) onto the account",
  "how much did I spend this billed period, what were my top merchants, and what should I watch next month?",
];

const USAGE = `usage: npm start -- [--skip-claude] [--keep-workspace]

  --skip-claude      skip the live "claude -p" turns; only check that the
                     ingest pipeline discovers the statement (no claude CLI
                     required)
  --keep-workspace   do not delete the isolated workspace on exit; prints
                     its path instead
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

// orchestration core - shared verbatim by the ink (TTY) and plain (piped) renderers below via the Reporter interface

interface Reporter {
  stepStart(id: string, label: string): void;
  stepDone(id: string, label: string, ok: boolean, detail?: string): void;
  turnStart(turn: number, total: number, prompt: string): void;
  turnActivity(turn: number, line: string): void;
  turnAnswer(turn: number, text: string): void;
  turnDone(turn: number, ok: boolean): void;
  info(line: string): void;
}

interface DemoOptions {
  skipClaude: boolean;
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

  for (let i = 0; i < TURN_PROMPTS.length; i++) {
    const turn = i + 1;
    const prompt = TURN_PROMPTS[i];
    report.turnStart(turn, TURN_PROMPTS.length, prompt);
    const result = await runClaudeTurn(
      { prompt, continueSession: turn > 1, cwd: ws.cwd, env, allowedTools: DEMO_TOOLS },
      (event) => {
        if (event.kind === "activity") report.turnActivity(turn, event.line);
        // "delta" events (live streaming text) are intentionally not
        // surfaced here - the authoritative answer comes from the turn's
        // "result" event (see claude-stream.ts), reported once below.
      },
    );
    report.turnAnswer(turn, result.answer || "(no answer text)");
    report.turnDone(turn, result.ok);
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
    },
    turnActivity(_turn, line) {
      console.log(line);
    },
    turnAnswer(_turn, text) {
      console.log("");
      console.log("answer:");
      console.log(text);
    },
    turnDone(_turn, ok) {
      console.log(DIVIDER);
      if (!ok) console.log("(turn failed)");
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
}

interface TurnData {
  turn: number;
  total: number;
  prompt: string;
  activity: string[];
  answer: string;
  status: "running" | "ok" | "fail";
}

interface UiState {
  steps: StepRow[];
  activeTurn: TurnData | null;
  turnHistory: TurnData[];
  infoLines: string[];
  done: boolean;
  pass: boolean;
}

const initialUiState: UiState = {
  steps: [],
  activeTurn: null,
  turnHistory: [],
  infoLines: [],
  done: false,
  pass: false,
};

type UiAction =
  | { type: "STEP_START"; id: string; label: string }
  | { type: "STEP_DONE"; id: string; ok: boolean; detail?: string }
  | { type: "TURN_START"; turn: number; total: number; prompt: string }
  | { type: "TURN_ACTIVITY"; turn: number; line: string }
  | { type: "TURN_ANSWER"; turn: number; text: string }
  | { type: "TURN_DONE"; turn: number; ok: boolean }
  | { type: "INFO"; line: string }
  | { type: "FINAL"; pass: boolean };

function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "STEP_START": {
      if (state.steps.some((s) => s.id === action.id)) {
        return { ...state, steps: state.steps.map((s) => (s.id === action.id ? { ...s, status: "running" } : s)) };
      }
      return { ...state, steps: [...state.steps, { id: action.id, label: action.label, status: "running" }] };
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
          answer: "",
          status: "running",
        },
      };
    case "TURN_ACTIVITY":
      if (!state.activeTurn || state.activeTurn.turn !== action.turn) return state;
      return { ...state, activeTurn: { ...state.activeTurn, activity: [...state.activeTurn.activity, action.line] } };
    case "TURN_ANSWER":
      if (!state.activeTurn || state.activeTurn.turn !== action.turn) return state;
      return { ...state, activeTurn: { ...state.activeTurn, answer: action.text } };
    case "TURN_DONE": {
      if (!state.activeTurn || state.activeTurn.turn !== action.turn) return state;
      const finished: TurnData = { ...state.activeTurn, status: action.ok ? "ok" : "fail" };
      return { ...state, activeTurn: null, turnHistory: [...state.turnHistory, finished] };
    }
    case "INFO":
      return { ...state, infoLines: [...state.infoLines, action.line] };
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
    turnAnswer(turn, text) {
      dispatch({ type: "TURN_ANSWER", turn, text });
    },
    turnDone(turn, ok) {
      dispatch({ type: "TURN_DONE", turn, ok });
    },
    info(line) {
      dispatch({ type: "INFO", line });
    },
  };
}

function TurnBlock({ turn }: { turn: TurnData }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{DIVIDER}</Text>
      <Text>
        {bracket(turn.status)} turn {turn.turn}/{turn.total}: {turn.prompt}
      </Text>
      {turn.activity.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      {turn.answer.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text>answer:</Text>
          {turn.answer.split("\n").map((line, i) => (
            <Text key={i}>{line.length > 0 ? line : " "}</Text>
          ))}
        </Box>
      )}
      <Text>{DIVIDER}</Text>
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

  return (
    <Box flexDirection="column">
      <Text>corgi-agent demo</Text>
      <Box flexDirection="column" marginTop={1}>
        {state.steps.map((s) => (
          <Text key={s.id}>
            {bracket(s.status)} {s.label}
            {s.detail ? `  ${s.detail}` : ""}
          </Text>
        ))}
      </Box>
      <Static items={state.turnHistory}>{(turn) => <TurnBlock key={turn.turn} turn={turn} />}</Static>
      {state.activeTurn && <TurnBlock turn={state.activeTurn} />}
      {state.infoLines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {state.infoLines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      )}
      {state.done && (
        <Box marginTop={1}>
          <Text>{state.pass ? "PASS" : "FAIL"}</Text>
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
  help: boolean;
  unknown: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { skipClaude: false, keepWorkspace: false, help: false, unknown: [] };
  for (const arg of argv) {
    if (arg === "--skip-claude") args.skipClaude = true;
    else if (arg === "--keep-workspace") args.keepWorkspace = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else args.unknown.push(arg);
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
  const opts: DemoOptions = { skipClaude: args.skipClaude };

  const code = process.stdout.isTTY ? await runTty(opts) : await runPlain(opts);
  process.exitCode = code;
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
