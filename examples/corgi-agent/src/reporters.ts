/**
 * The Reporter contract plus its two implementations - a plain (non-TTY /
 * piped) reporter that logs flat ASCII lines, and an ink reporter that
 * dispatches into the UI reducer - and the small formatting helpers both
 * renderers share. `runDemo` (orchestrate.ts) reports progress purely through
 * this contract, so both renderers drive the identical sequence.
 */
import type { Dispatch } from "react";
import type { UiAction } from "./ui-state.js";
import type { WorkspacePaths } from "./workspace.js";
import { runDemo, STEP_IDS, type DemoOptions } from "./orchestrate.js";

/** Full-width run divider - printed around each turn in plain mode and
 *  rendered dim in ink mode. */
export const DIVIDER = "-".repeat(60);

/** Plain-mode heartbeat cadence while a turn is running with no other output. */
const HEARTBEAT_MS = 15_000;

export interface TurnSummary {
  durationMs?: number;
  plasalidCalls: number;
}

export interface Reporter {
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

function bracket(status: "running" | "ok" | "fail"): string {
  if (status === "running") return "[....]";
  if (status === "ok") return "[ ok ]";
  return "[fail]";
}

function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Seconds label for a millisecond duration, e.g. 84213 -> "84s". */
export function formatSeconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** Shared turn-summary text for both renderers, e.g.
 *  "turn 1 done in 84s · 12 plasalid calls" (the "in Ns" clause is omitted
 *  when the duration is unknown). The ink renderer prefixes its own ✅/❌;
 *  plain mode prints this line as-is (ASCII). */
export function turnSummaryText(
  turn: number,
  ok: boolean,
  durationMs: number | undefined,
  plasalidCalls: number,
): string {
  let head = `turn ${turn} ${ok ? "done" : "failed"}`;
  if (typeof durationMs === "number") head += ` in ${formatSeconds(durationMs)}`;
  return `${head} · ${pluralize(plasalidCalls, "plasalid call")}`;
}

export function makePlainReporter(): Reporter {
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let turnStartedAt = 0;

  function clearHeartbeat(): void {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }
  /** (Re)arm the heartbeat: fires at most every HEARTBEAT_MS of silence, then
   *  reschedules itself so a long-silent turn keeps reassuring the user it's
   *  still alive. Any real output cancels/rearms this. */
  function scheduleHeartbeat(): void {
    clearHeartbeat();
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      console.log(`... thinking (${formatSeconds(Date.now() - turnStartedAt)})`);
      scheduleHeartbeat();
    }, HEARTBEAT_MS);
  }

  return {
    stepStart(id, _label) {
      // Piped output is a linear log: only completed steps print a line, except
      // for a single blank-line separator ahead of the final assertions step,
      // which otherwise would butt straight up against the last turn's divider.
      if (id === STEP_IDS.assertions) console.log("");
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
      // affordance (see the TTY renderer in ui.tsx).
    },
    turnAnswer(_turn, text) {
      // No heartbeat rearm here: turnDone clears it immediately after.
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
      console.log(turnSummaryText(turn, ok, summary.durationMs, summary.plasalidCalls));
    },
    info(line) {
      console.log(line);
    },
  };
}

export function makeInkReporter(
  dispatch: Dispatch<UiAction>,
  appendPendingDelta: (turn: number, text: string) => void,
): Reporter {
  return {
    stepStart(id, label) {
      dispatch({ type: "STEP_START", id, label, at: Date.now() });
    },
    stepDone(id, _label, ok, detail) {
      dispatch({ type: "STEP_DONE", id, ok, detail });
    },
    turnStart(turn, total, prompt) {
      dispatch({ type: "TURN_START", turn, total, prompt, at: Date.now() });
    },
    turnActivity(turn, line) {
      dispatch({ type: "TURN_ACTIVITY", turn, line });
    },
    turnDelta(turn, text) {
      // Buffered outside React state (see App's pendingDeltaRef and the
      // render-clock note in ui-state.ts). Never dispatched directly, so
      // however fast/often deltas arrive, no re-render fires until the next
      // TICK merges the buffer in.
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

/** Run the demo with the plain (piped/non-TTY) reporter, returning the process
 *  exit code. */
export async function runPlain(
  opts: DemoOptions,
  onWorkspaceReady: (paths: WorkspacePaths) => void,
  keepWorkspace: boolean,
): Promise<number> {
  console.log("corgi-agent demo");
  const reporter = makePlainReporter();
  const outcome = await runDemo(opts, reporter, onWorkspaceReady);
  if (outcome.paths && keepWorkspace) {
    reporter.info(`workspace kept at ${outcome.paths.root}`);
  }
  console.log(outcome.pass ? "PASS" : "FAIL");
  return outcome.pass ? 0 : 1;
}
