/**
 * The ink (TTY) renderer: the live dashboard components and the App that wires
 * the render clock, buffers streaming deltas outside React state, and runs the
 * demo. See ui-state.ts for the render-clock contract this depends on.
 */
import { useEffect, useReducer, useRef } from "react";
import { Box, render, Static, Text } from "ink";
import Spinner from "ink-spinner";
import {
  elapsedSeconds,
  initialUiState,
  type StepRow,
  TICK_MS,
  type TurnData,
  uiReducer,
  WRITING_WINDOW_MS,
} from "./ui-state.js";
import { DIVIDER, makeInkReporter, turnSummaryText } from "./reporters.js";
import { runDemo, type DemoOptions } from "./orchestrate.js";
import type { WorkspacePaths } from "./workspace.js";

/** Ink-only spinner style (cli-spinners "dots" - a braille cycle). */
const SPINNER_TYPE = "dots";

/** Only the last this-many lines of the live-streaming answer are shown (dim),
 *  with a "… (+N earlier lines)" head marker above them - bounds the dynamic
 *  region's height so ink never redraws a growing-without-limit area on every
 *  merge. */
const STREAMING_TEXT_MAX_LINES = 6;

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

/**
 * One turn's panel. `now` is supplied only for the active (running) turn to
 * drive its spinner/elapsed/streaming updates; completed turns are pinned to
 * scrollback via <Static> and rendered WITHOUT `now` (they never tick, and
 * their summary uses the recorded duration). Every place `now` is read is
 * inside the `running && now != null` branch, so its running-only use is
 * explicit and type-narrowed.
 */
function TurnBlock({ turn, now }: { turn: TurnData; now?: number }) {
  const running = turn.status === "running";
  const writing = now != null && turn.lastDeltaAt != null && now - turn.lastDeltaAt <= WRITING_WINDOW_MS;
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
      {/* Anchored status row: always its own Box (own line, marginTop for
          visual separation), always the last thing in the running turn's
          dynamic area (right before the still-empty answer/summary section).
          Three separate Text children (spinner / status word / elapsed) so ink
          diffs each piece independently instead of repainting one string. */}
      {running && now != null && (
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
          {turn.status === "ok" ? "✅" : "❌"}{" "}
          {turnSummaryText(turn.turn, turn.status === "ok", turn.durationMs, turn.plasalidCalls)}
        </Text>
      )}
      <Text dimColor>{DIVIDER}</Text>
    </Box>
  );
}

function App({
  opts,
  onWorkspaceReady,
  keepWorkspace,
  onExit,
}: {
  opts: DemoOptions;
  onWorkspaceReady: (paths: WorkspacePaths) => void;
  keepWorkspace: boolean;
  onExit: (code: number) => void;
}) {
  const [state, dispatch] = useReducer(uiReducer, initialUiState);
  const startedRef = useRef(false);
  /** Streaming-answer text buffered outside React state since the last TICK -
   *  see the render-clock note in ui-state.ts. Appending here never dispatches,
   *  so however fast/often deltas arrive, no re-render is triggered until the
   *  next TICK merges the buffer in. */
  const pendingDeltaRef = useRef<{ turn: number; text: string } | null>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const reporter = makeInkReporter(dispatch, (turn, text) => {
      const cur = pendingDeltaRef.current;
      pendingDeltaRef.current = cur && cur.turn === turn ? { turn, text: cur.text + text } : { turn, text };
    });
    (async () => {
      const outcome = await runDemo(opts, reporter, onWorkspaceReady);
      if (outcome.paths && keepWorkspace) {
        reporter.info(`workspace kept at ${outcome.paths.root}`);
      }
      dispatch({ type: "FINAL", pass: outcome.pass });
      // Give ink one tick to flush the final render (including Static content)
      // before the process exits.
      setTimeout(() => onExit(outcome.pass ? 0 : 1), 50);
    })();
  }, [opts, onWorkspaceReady, keepWorkspace, onExit]);

  // The single render clock: ticks the spinner/elapsed-time/streaming-text
  // displays every TICK_MS, but only while something is actually running -
  // cleared the instant we go idle/done so a finished run doesn't keep
  // re-rendering. uiReducer's TICK case further bails out (same state
  // reference, no re-render) on any tick where nothing visible changed.
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
      <Static items={state.turnHistory}>{(turn) => <TurnBlock key={turn.turn} turn={turn} />}</Static>
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

/** Run the demo with the ink (TTY) renderer, returning the process exit code. */
export function runTty(
  opts: DemoOptions,
  onWorkspaceReady: (paths: WorkspacePaths) => void,
  keepWorkspace: boolean,
): Promise<number> {
  return new Promise((resolveExit) => {
    const instance = render(
      <App
        opts={opts}
        onWorkspaceReady={onWorkspaceReady}
        keepWorkspace={keepWorkspace}
        onExit={(code) => {
          instance.unmount();
          resolveExit(code);
        }}
      />,
    );
  });
}
