/**
 * Dev check for the render clock (run via `npm run verify`).
 *
 * Feeds ~200 synthetic text_delta chunks plus a few tool_use NDJSON lines
 * through the real createStreamParser into the real uiReducer over ~3s, exactly
 * as the ink App does: deltas are buffered outside state and merged only on a
 * TICK_MS clock. It then asserts that the number of VISIBLE state changes is
 * bounded by the TICK cadence (~1000/TICK_MS per second), not by the number of
 * delta chunks - i.e. a fast delta stream can never drive a per-delta re-render.
 * Prints the counts and exits non-zero on violation.
 */
import { createStreamParser } from "./claude-stream.js";
import { initialUiState, TICK_MS, uiReducer, type UiAction, type UiState } from "./ui-state.js";

const DURATION_MS = 3000;
const RAW_DELTAS = 200;
const DELTA_TEXT = "lorem ";
const TURN = 1;

const deltaLine = JSON.stringify({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: DELTA_TEXT } },
});
const toolLine = (command: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });

// 200 delta lines with a tool_use sprinkled in every 50, plus one more = 4 total.
const lines: string[] = [];
for (let i = 0; i < RAW_DELTAS; i++) {
  lines.push(deltaLine);
  if (i > 0 && i % 50 === 0) lines.push(toolLine("plasalid status --json"));
}
lines.push(toolLine("plasalid transactions list --json"));
const TOOL_USES = 4;

let state: UiState = initialUiState;
let renderCount = 0;
let tickRenderCount = 0;
let totalTicks = 0;
let deltaEventCount = 0;
let activityEventCount = 0;
let plasalidCallCount = 0;

/** Dispatch through the real reducer; report whether a new state reference (a
 *  visible change) was produced, mirroring what would trigger a React render. */
function dispatch(action: UiAction): boolean {
  const prev = state;
  state = uiReducer(state, action);
  return state !== prev;
}

let pendingText = "";
const parser = createStreamParser((event) => {
  if (event.kind === "delta") {
    deltaEventCount++;
    pendingText += event.text; // buffered outside state, exactly like App's pendingDeltaRef
  } else if (event.kind === "activity") {
    activityEventCount++;
    if (dispatch({ type: "TURN_ACTIVITY", turn: TURN, line: event.line })) renderCount++;
  } else if (event.kind === "plasalid-call") {
    plasalidCallCount++;
  }
});

function tick(): void {
  totalTicks++;
  const pending = pendingText;
  pendingText = "";
  if (dispatch({ type: "TICK", now: Date.now(), pendingDelta: pending || undefined, pendingDeltaTurn: TURN })) {
    tickRenderCount++;
    renderCount++;
  }
}

const startedAt = Date.now();
dispatch({ type: "TURN_START", turn: TURN, total: 1, prompt: "verify render clock", at: startedAt });

const tickTimer = setInterval(tick, TICK_MS);
let fed = 0;
const feedTimer = setInterval(
  () => {
    if (fed < lines.length) parser.handleLine(lines[fed++]);
  },
  Math.max(1, Math.floor(DURATION_MS / lines.length)),
);

setTimeout(() => {
  clearInterval(feedTimer);
  while (fed < lines.length) parser.handleLine(lines[fed++]); // drain any stragglers
  parser.flush(); // emit the last buffered delta event
  tick(); // final merge of trailing buffered text
  clearInterval(tickTimer);
  parser.dispose();

  const elapsedMs = Date.now() - startedAt;
  const bound = Math.ceil(elapsedMs / TICK_MS) + 2;
  const streamingLen = state.activeTurn?.streamingText.length ?? 0;
  const expectedLen = RAW_DELTAS * DELTA_TEXT.length;

  console.log(`raw text_delta chunks fed:       ${RAW_DELTAS}`);
  console.log(`coalesced delta events emitted:  ${deltaEventCount}`);
  console.log(`tool_use lines fed:              ${TOOL_USES} (activity: ${activityEventCount}, plasalid-calls: ${plasalidCallCount})`);
  console.log(`TICKs dispatched:                ${totalTicks} over ${elapsedMs}ms`);
  console.log(`visible updates from TICK:       ${tickRenderCount} (cadence bound: <= ${bound})`);
  console.log(`total visible state updates:     ${renderCount}`);

  const problems: string[] = [];
  if (tickRenderCount > bound) {
    problems.push(`TICK-driven visible updates (${tickRenderCount}) exceed the TICK-cadence bound (${bound}).`);
  }
  if (tickRenderCount * 4 >= RAW_DELTAS) {
    problems.push(`visible updates (${tickRenderCount}) track the delta count (${RAW_DELTAS}), not the clock - deltas are re-rendering per-chunk.`);
  }
  if (streamingLen !== expectedLen) {
    problems.push(`streamingText length ${streamingLen} != expected ${expectedLen}; delta text was lost in buffering/merge.`);
  }

  if (problems.length > 0) {
    console.error(`\nFAIL:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`\nOK: ${RAW_DELTAS} deltas produced only ${tickRenderCount} TICK-bounded visible updates (all text merged).`);
  process.exit(0);
}, DURATION_MS + 500);
