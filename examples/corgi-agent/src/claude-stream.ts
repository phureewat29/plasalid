/**
 * Spawns the `claude` CLI in `-p --output-format stream-json
 * --include-partial-messages --verbose` mode and turns its NDJSON event
 * stream into what the demo UI needs: activity lines ("> plasalid ..." /
 * "> Read ..." / "> Write ...") for each tool_use the agent makes, coalesced
 * live-streaming answer text, skill/plasalid-call usage signals, and the
 * turn's final answer/duration/cost.
 *
 * Event shapes observed from a real `claude -p ... --output-format
 * stream-json --include-partial-messages --verbose` run (claude_code_version
 * 2.1.211):
 *
 *   {"type":"system","subtype":"init",...}                      -- ignored
 *   {"type":"system","subtype":"status","status":"requesting"}  -- ignored
 *   {"type":"stream_event","event":{"type":"message_start",...}}
 *   {"type":"stream_event","event":{"type":"content_block_start",...}}
 *   {"type":"stream_event","event":{"type":"content_block_delta",
 *      "delta":{"type":"text_delta","text":"O"}}}                -- live text
 *   {"type":"stream_event","event":{"type":"content_block_delta",
 *      "delta":{"type":"input_json_delta","partial_json":"..."}}} -- ignored
 *      (partial tool-call JSON fragments; too fragile to reassemble, see
 *      below - the complete "assistant" event carries the parsed input)
 *   {"type":"stream_event","event":{"type":"content_block_stop"|"message_delta"|"message_stop"}}
 *   {"type":"assistant","message":{"content":[{"type":"thinking",...}|
 *      {"type":"tool_use","name":"Bash","input":{"command":"..."}}|
 *      {"type":"tool_use","name":"Read","input":{"file_path":"..."}}|
 *      {"type":"tool_use","name":"Skill","input":{"command":"<skill-name>"}}|
 *      {"type":"text","text":"..."}]}}                           -- tool_use
 *      blocks here have the FULL parsed input already, so activity lines are
 *      built from this event, not the partial input_json_delta fragments.
 *   {"type":"user","message":{"content":[{"type":"tool_result",...}]}}  -- ignored
 *   {"type":"result","subtype":"success","result":"<final answer text>",
 *      "duration_ms":84213,"total_cost_usd":0.1234,"usage":{...},...}
 *      -- the authoritative final answer for the whole turn (matches what a
 *      plain `claude -p "<prompt>"` would have printed to stdout), plus
 *      informational duration/cost fields.
 *
 * Any event type/shape not listed above (and any field access below) is
 * treated defensively: unknown types are ignored, and missing/mistyped
 * fields degrade to empty/no-op rather than throwing, since this is a best
 * effort live view - the turn's real outcome is the process exit code plus
 * the "result" event's answer text.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface ClaudeTurnOptions {
  prompt: string;
  /** Pass `--continue` so this turn resumes the demo's own session. */
  continueSession: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** e.g. "Bash(plasalid:*),Read,Write,Skill" */
  allowedTools: string;
  /** SIGTERM (then SIGKILL after 5s) the turn if it runs past this many
   *  seconds. Defaults to DEFAULT_TURN_TIMEOUT_SEC. */
  turnTimeoutSec?: number;
}

export type ClaudeStreamEvent =
  /** One tool invocation, already formatted as a "> ..." display line. */
  | { kind: "activity"; line: string }
  /** A coalesced chunk of the assistant's streaming answer text (live/optimistic). */
  | { kind: "delta"; text: string }
  /** The agent invoked the Skill tool (skillName is best-effort, may be null). */
  | { kind: "skill"; skillName: string | null }
  /** The agent ran a Bash tool_use whose command starts with `plasalid`. */
  | { kind: "plasalid-call" };

export interface ClaudeTurnResult {
  ok: boolean;
  exitCode: number | null;
  /** The authoritative final answer, sourced from the "result" event. */
  answer: string;
  /** From the "result" event's `duration_ms`, when present. */
  durationMs?: number;
  /** From the "result" event's `total_cost_usd`, when present. */
  costUsd?: number;
  /** Set when the turn was killed for running past `turnTimeoutSec`. */
  timedOut?: boolean;
  /** Last (up to) 3 non-blank stderr lines, only populated when the turn
   *  succeeded but still wrote something to stderr. */
  stderrTail?: string[];
}

export const DEFAULT_TURN_TIMEOUT_SEC = 600;

/** How long to buffer text_delta chunks before flushing a coalesced "delta"
 *  event - keeps the live-streaming UI update rate sane without waiting for
 *  the whole answer. */
const DELTA_FLUSH_MS = 80;

const ACTIVITY_LINE_MAX = 120;

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 3))}...` : oneLine;
}

/** Last (up to) `n` non-blank lines of `s`, trimmed of trailing whitespace. */
function lastLines(s: string, n: number): string[] {
  const lines = s
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  return lines.slice(-n);
}

function bashCommand(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const v = (input as Record<string, unknown>).command;
  return typeof v === "string" ? v : "";
}

/** Best-effort skill name out of a Skill tool_use's input - the exact field
 *  name isn't documented, so try the likely candidates and fall back to null
 *  rather than throwing or guessing wrong. */
function skillNameFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  for (const key of ["command", "skill", "skill_name", "name"]) {
    const v = obj[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/** Build the "> ..." activity line for a single tool_use content block.
 *  Defensive: only Bash/Read/Write/Skill are expected (the demo's
 *  --allowedTools never grants anything else), but any other tool name
 *  still gets a bare "> ToolName" line instead of being silently dropped. */
function activityLineForToolUse(name: unknown, input: unknown): string | null {
  const params = (input && typeof input === "object" ? (input as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  if (name === "Bash") {
    const command = typeof params.command === "string" ? params.command : "";
    return `> ${truncate(command, ACTIVITY_LINE_MAX)}`;
  }
  if (name === "Read") {
    return `> Read ${String(params.file_path ?? "")}`;
  }
  if (name === "Write") {
    return `> Write ${String(params.file_path ?? "")}`;
  }
  if (typeof name === "string" && name) return `> ${name}`;
  return null;
}

export interface StreamParserResult {
  answer: string;
  durationMs?: number;
  costUsd?: number;
}

/** Incrementally parses one turn's NDJSON stdout lines into ClaudeStreamEvents.
 *  Pulled out of `runClaudeTurn` so it can be driven by a synthetic line feed
 *  in tests/dev scripts without spawning a real `claude` process. */
export interface StreamParser {
  /** Feed one raw stdout line (may be blank/partial/non-JSON; handled defensively). */
  handleLine(rawLine: string): void;
  /** Flush any buffered delta text immediately, emitting a final "delta" event if non-empty. */
  flush(): void;
  /** Cancel any pending internal timers. Safe to call more than once. */
  dispose(): void;
  /** Snapshot of the result fields accumulated so far. */
  getResult(): StreamParserResult;
}

export function createStreamParser(onEvent: (event: ClaudeStreamEvent) => void): StreamParser {
  let finalAnswer = "";
  let durationMs: number | undefined;
  let costUsd: number | undefined;
  let deltaBuffer = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushNow(): void {
    if (deltaBuffer.length === 0) return;
    const text = deltaBuffer;
    deltaBuffer = "";
    onEvent({ kind: "delta", text });
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushNow();
    }, DELTA_FLUSH_MS);
  }

  function handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;

    let evt: unknown;
    try {
      evt = JSON.parse(line);
    } catch {
      return; // partial/non-JSON line: ignore defensively
    }
    if (!evt || typeof evt !== "object") return;
    const e = evt as Record<string, unknown>;

    switch (e.type) {
      case "assistant": {
        const message = e.message as { content?: unknown } | undefined;
        const content = message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && (block as { type?: unknown }).type === "tool_use") {
              const b = block as { name?: unknown; input?: unknown };
              const activityLine = activityLineForToolUse(b.name, b.input);
              if (activityLine) onEvent({ kind: "activity", line: activityLine });
              if (b.name === "Skill") {
                onEvent({ kind: "skill", skillName: skillNameFromInput(b.input) });
              } else if (b.name === "Bash" && bashCommand(b.input).trim().startsWith("plasalid")) {
                onEvent({ kind: "plasalid-call" });
              }
            }
          }
        }
        break;
      }
      case "stream_event": {
        const inner = e.event as { type?: unknown; delta?: unknown } | undefined;
        if (inner?.type === "content_block_delta") {
          const delta = inner.delta as { type?: unknown; text?: unknown } | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
            deltaBuffer += delta.text;
            scheduleFlush();
          }
        }
        break;
      }
      case "result": {
        if (typeof e.result === "string") finalAnswer = e.result;
        if (typeof e.duration_ms === "number") durationMs = e.duration_ms;
        if (typeof e.total_cost_usd === "number") costUsd = e.total_cost_usd;
        break;
      }
      default:
        // system/user/other events aren't needed for this demo's display.
        break;
    }
  }

  return {
    handleLine,
    flush() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushNow();
    },
    dispose() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    },
    getResult() {
      return { answer: finalAnswer, durationMs, costUsd };
    },
  };
}

/**
 * Run one `claude -p` turn, streaming activity/delta/skill/plasalid-call
 * events to `onEvent` as they arrive, resolving once the process exits (or
 * is killed for timing out) with the turn's outcome.
 */
export function runClaudeTurn(
  opts: ClaudeTurnOptions,
  onEvent: (event: ClaudeStreamEvent) => void,
): Promise<ClaudeTurnResult> {
  return new Promise((resolvePromise) => {
    const args = ["-p"];
    if (opts.continueSession) args.push("--continue");
    args.push(opts.prompt, "--allowedTools", opts.allowedTools, "--output-format", "stream-json");
    args.push("--include-partial-messages", "--verbose");

    const child = spawn("claude", args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    let closed = false;
    let timedOut = false;

    const parser = createStreamParser(onEvent);
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (raw) => parser.handleLine(raw));

    child.stderr.on("data", (chunk) => {
      stderrBuf += String(chunk);
    });

    const turnTimeoutSec = opts.turnTimeoutSec ?? DEFAULT_TURN_TIMEOUT_SEC;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, 5000);
    }, turnTimeoutSec * 1000);

    function clearTimers(): void {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    }

    child.on("error", (err) => {
      closed = true;
      clearTimers();
      parser.dispose();
      resolvePromise({ ok: false, exitCode: null, answer: stderrBuf || err.message });
    });

    child.on("close", (code) => {
      closed = true;
      clearTimers();
      parser.flush();
      parser.dispose();
      const { answer, durationMs, costUsd } = parser.getResult();

      if (timedOut) {
        resolvePromise({
          ok: false,
          exitCode: code,
          answer: `turn timed out after ${turnTimeoutSec}s`,
          durationMs,
          costUsd,
          timedOut: true,
        });
        return;
      }

      const ok = code === 0;
      const stderrTail = ok && stderrBuf.trim() ? lastLines(stderrBuf, 3) : undefined;
      resolvePromise({ ok, exitCode: code, answer: answer || stderrBuf, durationMs, costUsd, stderrTail });
    });
  });
}
