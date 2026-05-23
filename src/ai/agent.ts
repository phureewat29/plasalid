import type Database from "libsql";
import { config, getActiveModel } from "../config.js";
import {
  buildChatSystemPrompt,
  buildScanSystemPrompt,
  buildClarifySystemPrompt,
  buildRecordSystemPrompt,
  type ScanPromptOptions,
  type ClarifyPromptOptions,
  type RecordPromptOptions,
} from "./system-prompt.js";
import { getToolDefinitions, executeTool, type AgentExecutionContext } from "./tools/index.js";
import { getConversationHistory, saveMessage } from "./memory.js";
import { recordQuestion } from "../db/queries/questions.js";
import { redact, unredact } from "./redactor.js";
import { getProvider } from "./providers/index.js";
import {
  AbortedError,
  ApiAuthError,
  ApiError,
  RateLimitError,
} from "./errors.js";
import type {
  NormalizedMessage,
  NormalizedToolResult,
  NormalizedContentBlock,
  ToolDefinition,
} from "./provider.js";

export { AbortedError } from "./errors.js";

const provider = getProvider();

const MAX_TOOL_STEPS = 20;

export type ProgressCallback = (event: {
  phase: "tool" | "responding";
  toolName?: string;
  toolCount: number;
  elapsedMs: number;
}) => void;

export type TruncationReason = "tool_steps" | "max_tokens";

interface RunAgentArgs {
  db: Database.Database;
  systemPrompt: string;
  tools: ToolDefinition[];
  initialMessages: NormalizedMessage[];
  agentCtx?: AgentExecutionContext;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
  maxToolSteps?: number;
  maxOutputTokens?: number;
}

async function runAgent({
  db,
  systemPrompt,
  tools,
  initialMessages,
  agentCtx,
  onProgress,
  signal,
  maxToolSteps,
  maxOutputTokens,
}: RunAgentArgs): Promise<{
  text: string;
  messages: NormalizedMessage[];
  truncated: TruncationReason | null;
}> {
  const messages: NormalizedMessage[] = [...initialMessages];
  const useThinking = config.thinkingBudget > 0 && provider.supportsThinking;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new AbortedError();
  };
  const stepLimit = maxToolSteps ?? MAX_TOOL_STEPS;
  const baseMaxTokens = maxOutputTokens ?? 4096;
  const requestMaxTokens = useThinking ? 16000 : baseMaxTokens;

  const startTime = Date.now();
  let toolCount = 0;

  throwIfAborted();
  let response = await provider.sendMessage({
    model: getActiveModel(),
    maxTokens: requestMaxTokens,
    system: systemPrompt,
    tools,
    messages,
    thinking: useThinking ? { type: "enabled", budget_tokens: config.thinkingBudget } : undefined,
    signal,
  });

  while (response.stopReason === "tool_use" && toolCount < stepLimit) {
    throwIfAborted();
    messages.push({ role: "assistant", content: response.content });
    const toolResults: NormalizedToolResult[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        toolCount++;
        onProgress?.({ phase: "tool", toolName: block.name, toolCount, elapsedMs: Date.now() - startTime });
        const result = await executeTool(db, block.name, block.input, agentCtx);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: redact(result.content),
          ...(result.isError ? { is_error: true } : {}),
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
    onProgress?.({ phase: "responding", toolCount, elapsedMs: Date.now() - startTime });

    throwIfAborted();
    response = await provider.sendMessage({
      model: getActiveModel(),
      maxTokens: requestMaxTokens,
      system: systemPrompt,
      tools,
      messages,
      thinking: useThinking ? { type: "enabled", budget_tokens: config.thinkingBudget } : undefined,
      signal,
    });
  }

  let truncated: TruncationReason | null = null;
  if (response.stopReason === "max_tokens") {
    truncated = "max_tokens";
  } else if (response.stopReason === "tool_use" && toolCount >= stepLimit) {
    truncated = "tool_steps";
  }

  const textBlocks = response.content.filter(
    (b): b is Extract<NormalizedContentBlock, { type: "text" }> => b.type === "text",
  );
  const text = unredact(textBlocks.map(b => b.text).join("\n"));
  return { text, messages, truncated };
}

const SCAN_MAX_TOOL_STEPS = 100;
const RESOLVE_MAX_TOOL_STEPS = 60;
// Statement pages routinely produce a single batched record_transactions call
// holding 100+ rows; 4096 tokens cuts those off mid-array. 8192 is the
// smallest cap that fits a dense page without forcing the agent to chunk.
const SCAN_MAX_OUTPUT_TOKENS = 8192;

/**
 * Conversational chat used by the Ink TUI. Reuses conversation_history for context
 * continuity, redacts PII on the way out, restores it on the way in for display.
 */
export async function handleChatMessage(
  db: Database.Database,
  userMessage: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<string> {
  saveMessage(db, "user", userMessage);

  const rawHistory = getConversationHistory(db, 30);
  const MAX_HISTORY_CHARS = 24_000;
  let historyChars = 0;
  const history: typeof rawHistory = [];
  for (let i = rawHistory.length - 1; i >= 0; i--) {
    historyChars += rawHistory[i].content.length;
    if (historyChars > MAX_HISTORY_CHARS) break;
    history.unshift(rawHistory[i]);
  }

  const systemPrompt = redact(buildChatSystemPrompt(db));
  const messages: NormalizedMessage[] = history.map(h => ({
    role: h.role as "user" | "assistant",
    content: redact(h.content),
  }));
  if (messages.length === 0 || messages[messages.length - 1].content !== redact(userMessage)) {
    messages.push({ role: "user", content: redact(userMessage) });
  }

  try {
    const { text } = await runAgent({
      db,
      systemPrompt,
      tools: getToolDefinitions("chat"),
      initialMessages: messages,
      onProgress,
      signal,
    });
    saveMessage(db, "assistant", text);
    return text || "I couldn't formulate a response. Could you rephrase?";
  } catch (error) {
    if (error instanceof AbortedError) throw error;
    if (signal?.aborted) throw new AbortedError();
    if (error instanceof ApiAuthError) {
      return "API key was rejected. Run `plasalid setup` to reconfigure your credentials.";
    }
    if (error instanceof RateLimitError) {
      return "Rate limited. Wait a moment and try again.";
    }
    if (error instanceof ApiError) {
      console.error("AI error:", `API error (${error.status ?? "?"}): ${error.message}`);
      return "Sorry, I had trouble processing that. Could you try again?";
    }
    console.error("AI error:", (error as Error).message || "internal error");
    return "Sorry, I had trouble processing that. Could you try again?";
  }
}

/**
 * Scan-time agent loop. Caller supplies the initial user message (which carries
 * the PDF as a content block) and a AgentExecutionContext that scopes the file
 * id, scanId, and progress sink. A truncated run records a scan_truncated
 * question so clarify can surface it later.
 */
export async function runScanAgent(opts: {
  db: Database.Database;
  initialMessages: NormalizedMessage[];
  prompt: ScanPromptOptions;
  agentCtx: AgentExecutionContext;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}): Promise<string> {
  const systemPrompt = redact(buildScanSystemPrompt(opts.db, opts.prompt));
  const { text, truncated } = await runAgent({
    db: opts.db,
    systemPrompt,
    tools: getToolDefinitions("scan"),
    initialMessages: opts.initialMessages,
    agentCtx: opts.agentCtx,
    onProgress: opts.onProgress,
    signal: opts.signal,
    maxToolSteps: SCAN_MAX_TOOL_STEPS,
    maxOutputTokens: SCAN_MAX_OUTPUT_TOKENS,
  });
  if (truncated) {
    recordQuestion(opts.db, {
      file_id: opts.agentCtx.fileId ?? null,
      scan_id: opts.agentCtx.scanId ?? null,
      transaction_id: null,
      account_id: null,
      kind: "scan_truncated",
      prompt:
        truncated === "max_tokens"
          ? `Scan hit the output-token budget (${SCAN_MAX_OUTPUT_TOKENS}) mid-response, so the last tool call was cut off. Some transactions may be missing. Re-scan after splitting the PDF further, or raise the budget.`
          : `Scan stopped at the tool-step cap (${SCAN_MAX_TOOL_STEPS}) before the agent finished parsing this chunk. Some transactions may be missing. Split the PDF further or raise the cap.`,
    });
    if (opts.agentCtx.progress && opts.agentCtx.chunkId) {
      opts.agentCtx.progress.emit({ chunkId: opts.agentCtx.chunkId, kind: "question" });
    }
  }
  return text;
}

/**
 * Record-time agent loop. Takes one natural-language utterance and walks the
 * record tool profile. Single-shot — does not persist conversation history.
 */
export async function runRecordAgent(opts: {
  db: Database.Database;
  initialMessages: NormalizedMessage[];
  prompt: RecordPromptOptions;
  agentCtx: AgentExecutionContext;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}): Promise<string> {
  const systemPrompt = redact(buildRecordSystemPrompt(opts.db, opts.prompt));
  const { text } = await runAgent({
    db: opts.db,
    systemPrompt,
    tools: getToolDefinitions("record"),
    initialMessages: opts.initialMessages,
    agentCtx: opts.agentCtx,
    onProgress: opts.onProgress,
    signal: opts.signal,
    maxToolSteps: 30,
  });
  return text;
}

/**
 * Clarify-time agent loop. Driven by CLARIFY_PERSONA. Surveys every open
 * question, applies memory/heuristic resolutions silently, groups whatever
 * remains and asks the user once per group via ask_user.
 */
export async function runClarifyAgent(opts: {
  db: Database.Database;
  initialMessages: NormalizedMessage[];
  prompt: ClarifyPromptOptions;
  agentCtx: AgentExecutionContext;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}): Promise<string> {
  const systemPrompt = redact(buildClarifySystemPrompt(opts.db, opts.prompt));
  const { text } = await runAgent({
    db: opts.db,
    systemPrompt,
    tools: getToolDefinitions("clarify"),
    initialMessages: opts.initialMessages,
    agentCtx: opts.agentCtx,
    onProgress: opts.onProgress,
    signal: opts.signal,
    maxToolSteps: RESOLVE_MAX_TOOL_STEPS,
  });
  return text;
}
