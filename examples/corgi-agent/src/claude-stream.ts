/**
 * Spawns the `claude` CLI in `-p --output-format stream-json
 * --include-partial-messages --verbose` mode and turns its NDJSON event
 * stream into the two things the demo UI needs: activity lines ("> plasalid
 * ..." / "> Read ..." / "> Write ...") for each tool_use the agent makes, and
 * the turn's final answer text.
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
 *      {"type":"text","text":"..."}]}}                           -- tool_use
 *      blocks here have the FULL parsed input already, so activity lines are
 *      built from this event, not the partial input_json_delta fragments.
 *   {"type":"user","message":{"content":[{"type":"tool_result",...}]}}  -- ignored
 *   {"type":"result","subtype":"success","result":"<final answer text>",...}
 *      -- the authoritative final answer for the whole turn (matches what a
 *      plain `claude -p "<prompt>"` would have printed to stdout).
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
  /** e.g. "Bash(plasalid:*),Read,Write" */
  allowedTools: string;
}

export type ClaudeStreamEvent =
  /** One tool invocation, already formatted as a "> ..." display line. */
  | { kind: "activity"; line: string }
  /** A chunk of the assistant's streaming answer text (live/optimistic). */
  | { kind: "delta"; text: string };

export interface ClaudeTurnResult {
  ok: boolean;
  exitCode: number | null;
  /** The authoritative final answer, sourced from the "result" event. */
  answer: string;
}

const ACTIVITY_LINE_MAX = 120;

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 3))}...` : oneLine;
}

/** Build the "> ..." activity line for a single tool_use content block.
 *  Defensive: only Bash/Read/Write are expected (the demo's --allowedTools
 *  never grants anything else), but any other tool name still gets a bare
 *  "> ToolName" line instead of being silently dropped. */
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

/**
 * Run one `claude -p` turn, streaming activity/delta events to `onEvent` as
 * they arrive, resolving once the process exits with the turn's outcome.
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

    let finalAnswer = "";
    let stderrBuf = "";

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (raw) => {
      const line = raw.trim();
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
              onEvent({ kind: "delta", text: delta.text });
            }
          }
          break;
        }
        case "result": {
          if (typeof e.result === "string") finalAnswer = e.result;
          break;
        }
        default:
          // system/user/other events aren't needed for this demo's display.
          break;
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuf += String(chunk);
    });

    child.on("error", (err) => {
      resolvePromise({ ok: false, exitCode: null, answer: stderrBuf || err.message });
    });

    child.on("close", (code) => {
      resolvePromise({ ok: code === 0, exitCode: code, answer: finalAnswer || stderrBuf });
    });
  });
}
