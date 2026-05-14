import type Database from "libsql";
import { config } from "../config.js";
import {
  buildChatSystemPrompt,
  buildScanSystemPrompt,
  buildReconcileSystemPrompt,
  type ScanPromptOptions,
  type ReconcilePromptOptions,
} from "./system-prompt.js";
import { getToolDefinitions, executeTool, type AgentExecutionContext } from "./tools/index.js";
import { getConversationHistory, saveMessage } from "./memory.js";
import { redact, unredact } from "./redactor.js";
import { createProvider } from "./providers/index.js";
import type {
  NormalizedMessage,
  NormalizedToolResult,
  NormalizedContentBlock,
  ToolDefinition,
} from "./provider.js";

const provider = createProvider();

const MAX_TOOL_STEPS = 20;

export type ProgressCallback = (event: {
  phase: "tool" | "responding";
  toolName?: string;
  toolCount: number;
  elapsedMs: number;
}) => void;

export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

interface RunAgentArgs {
  db: Database.Database;
  systemPrompt: string;
  tools: ToolDefinition[];
  initialMessages: NormalizedMessage[];
  agentCtx?: AgentExecutionContext;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
  maxToolSteps?: number;
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
}: RunAgentArgs): Promise<{ text: string; messages: NormalizedMessage[] }> {
  const messages: NormalizedMessage[] = [...initialMessages];
  const useThinking = config.thinkingBudget > 0 && provider.supportsThinking;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new AbortedError();
  };
  const stepLimit = maxToolSteps ?? MAX_TOOL_STEPS;

  throwIfAborted();
  let response = await provider.sendMessage({
    model: config.model,
    maxTokens: useThinking ? 16000 : 4096,
    system: systemPrompt,
    tools,
    messages,
    thinking: useThinking ? { type: "enabled", budget_tokens: config.thinkingBudget } : undefined,
    signal,
  });

  const startTime = Date.now();
  let toolCount = 0;

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
          content: redact(result),
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
    onProgress?.({ phase: "responding", toolCount, elapsedMs: Date.now() - startTime });

    throwIfAborted();
    response = await provider.sendMessage({
      model: config.model,
      maxTokens: useThinking ? 16000 : 4096,
      system: systemPrompt,
      tools,
      messages,
      thinking: useThinking ? { type: "enabled", budget_tokens: config.thinkingBudget } : undefined,
      signal,
    });
  }

  const textBlocks = response.content.filter(
    (b): b is Extract<NormalizedContentBlock, { type: "text" }> => b.type === "text",
  );
  const text = unredact(textBlocks.map(b => b.text).join("\n"));
  return { text, messages };
}

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
  } catch (error: any) {
    if (error instanceof AbortedError || error?.name === "AbortError" || signal?.aborted) {
      throw new AbortedError();
    }
    if (error.status === 401 || error.status === 403) {
      return "API key was rejected. Run `plasalid setup` to reconfigure your credentials.";
    }
    if (error.status === 429) {
      return "Rate limited. Wait a moment and try again.";
    }
    const safeMessage = error.status ? `API error (${error.status}): ${error.message || ""}` : error.message || "internal error";
    console.error("AI error:", safeMessage);
    return "Sorry, I had trouble processing that. Could you try again?";
  }
}

/**
 * Scan-time agent loop. Caller supplies the initial user message (which carries
 * the PDF as a content block) and a AgentExecutionContext that scopes the file
 * id, scanner version, and interactivity for ask_user.
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
  const { text } = await runAgent({
    db: opts.db,
    systemPrompt,
    tools: getToolDefinitions("scan"),
    initialMessages: opts.initialMessages,
    agentCtx: opts.agentCtx,
    onProgress: opts.onProgress,
    signal: opts.signal,
    maxToolSteps: 40,
  });
  return text;
}

/**
 * Reconcile-time agent loop. Walks the existing journal with the reconcile
 * tool profile (read tools + write/merge/delete primitives).
 */
export async function runReconcileAgent(opts: {
  db: Database.Database;
  initialMessages: NormalizedMessage[];
  prompt: ReconcilePromptOptions;
  agentCtx: AgentExecutionContext;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}): Promise<string> {
  const systemPrompt = redact(buildReconcileSystemPrompt(opts.db, opts.prompt));
  const { text } = await runAgent({
    db: opts.db,
    systemPrompt,
    tools: getToolDefinitions("reconcile"),
    initialMessages: opts.initialMessages,
    agentCtx: opts.agentCtx,
    onProgress: opts.onProgress,
    signal: opts.signal,
    maxToolSteps: 60,
  });
  return text;
}
