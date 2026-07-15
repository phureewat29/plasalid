/**
 * The ink renderer's UI state: types, the render-clock constants, and the
 * single pure reducer that drives every visible update.
 *
 * Render clock: a single interval (TICK_MS) drives every spinner / elapsed /
 * streaming-text update in the ink renderer (see ui.tsx's App). Streaming
 * deltas are never dispatched as they arrive - they're buffered outside React
 * state and merged into visible state only on TICK, which itself is a no-op
 * (same state reference, no re-render) whenever nothing a viewer would see has
 * actually changed. See the "TICK" case below.
 *
 * The reducer is fully pure: STEP_START / TURN_START / TICK all carry the
 * clock reading (`at` / `now`) on the action, set at dispatch time by the ink
 * reporter, so the reducer never reads the wall clock itself.
 */

/** Single render-clock cadence (ms) for the ink UI: drives BOTH the
 *  elapsed-time ticker and the merge of buffered streaming-answer deltas into
 *  visible state. 250-400ms is fast enough to read as "live" while
 *  guaranteeing no delta chunk, however small or frequent, can itself trigger
 *  a re-render. */
export const TICK_MS = 300;

/** A delta is treated as "still writing" (vs. "thinking") while it's this
 *  recent. */
export const WRITING_WINDOW_MS = 2000;

export interface StepRow {
  id: string;
  label: string;
  status: "running" | "ok" | "fail";
  detail?: string;
  startedAt: number;
}

export interface TurnData {
  turn: number;
  total: number;
  prompt: string;
  activity: string[];
  /** Coalesced live-streaming answer text; cleared once the authoritative answer lands. */
  streamingText: string;
  /** Timestamp of the last TICK that merged non-empty delta text into
   *  `streamingText`, or null if no delta has arrived yet. Drives the
   *  "thinking…" vs "writing…" status word. */
  lastDeltaAt: number | null;
  answer: string;
  status: "running" | "ok" | "fail";
  startedAt: number;
  plasalidCalls: number;
  durationMs?: number;
  stderrTail: string[];
}

export interface UiState {
  steps: StepRow[];
  activeTurn: TurnData | null;
  turnHistory: TurnData[];
  infoLines: string[];
  /** Updated on TICK while anything is running; drives spinner/elapsed rendering. */
  now: number;
  done: boolean;
  pass: boolean;
}

export const initialUiState: UiState = {
  steps: [],
  activeTurn: null,
  turnHistory: [],
  infoLines: [],
  now: Date.now(),
  done: false,
  pass: false,
};

export type UiAction =
  | { type: "STEP_START"; id: string; label: string; at: number }
  | { type: "STEP_DONE"; id: string; ok: boolean; detail?: string }
  | { type: "TURN_START"; turn: number; total: number; prompt: string; at: number }
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

export function elapsedSeconds(now: number, startedAt: number): number {
  return Math.max(0, Math.round((now - startedAt) / 1000));
}

export function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "STEP_START": {
      if (state.steps.some((s) => s.id === action.id)) {
        return {
          ...state,
          steps: state.steps.map((s) =>
            s.id === action.id ? { ...s, status: "running", startedAt: action.at } : s,
          ),
        };
      }
      return {
        ...state,
        steps: [...state.steps, { id: action.id, label: action.label, status: "running", startedAt: action.at }],
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
          startedAt: action.at,
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
        // Nothing a viewer would see has changed - return the SAME reference
        // so React bails out of re-rendering entirely.
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
