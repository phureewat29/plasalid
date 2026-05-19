import OpenAI from "openai";
import { classifyProviderError } from "../errors.js";
import type {
  Provider,
  SendMessageParams,
  NormalizedResponse,
  NormalizedContentBlock,
  NormalizedMessage,
  NormalizedToolResult,
  ToolDefinition,
} from "../provider.js";

type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
type NonStreamingParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type RequestOptions = Parameters<OpenAI["chat"]["completions"]["create"]>[1];

interface CompletionBody {
  model: string;
  maxTokens: number;
  messages: OpenAI.ChatCompletionMessageParam[];
  tools: OpenAI.ChatCompletionTool[] | undefined;
}

function isMaxTokensRejection(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  return err.status === 400 && (err.message?.includes("max_tokens") ?? false);
}

/**
 * Some OpenAI-compatible endpoints (older models, Ollama, vLLM) accept `max_tokens`;
 * newer OpenAI models require `max_completion_tokens`. Try the former, fall back on a
 * 400 that explicitly names the parameter.
 */
async function createCompletionWithTokenFallback(
  client: OpenAI,
  body: CompletionBody,
  options: RequestOptions,
): Promise<ChatCompletion> {
  const base: Omit<NonStreamingParams, "max_tokens" | "max_completion_tokens"> = {
    model: body.model,
    messages: body.messages,
    tools: body.tools,
  };
  try {
    return await client.chat.completions.create(
      { ...base, max_tokens: body.maxTokens },
      options,
    );
  } catch (e) {
    if (isMaxTokensRejection(e)) {
      return await client.chat.completions.create(
        { ...base, max_completion_tokens: body.maxTokens },
        options,
      );
    }
    throw e;
  }
}

export function createOpenAICompatibleProvider(opts: {
  apiKey: string;
  baseURL: string;
}): Provider {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
  });

  return {
    name: "openai-compatible",
    supportsThinking: false,

    async sendMessage(params: SendMessageParams): Promise<NormalizedResponse> {
      const tools = convertTools(params.tools);
      const body: CompletionBody = {
        model: params.model,
        maxTokens: params.maxTokens,
        messages: convertMessages(params.system, params.messages),
        tools: tools.length > 0 ? tools : undefined,
      };

      let response: ChatCompletion;
      try {
        response = await createCompletionWithTokenFallback(client, body, { signal: params.signal });
      } catch (e) {
        classifyProviderError(e, params.signal);
      }

      return normalizeResponse(response);
    },
  };
}

function normalizeResponse(response: ChatCompletion): NormalizedResponse {
  const choice = response.choices[0];
  if (!choice) {
    return { content: [], stopReason: "end_turn" };
  }

  const content: NormalizedContentBlock[] = [];

  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content });
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      if (tc.type !== "function") continue;
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: parseArguments(tc.function.arguments),
      });
    }
  }

  const hasToolCalls = content.some((b) => b.type === "tool_use");

  return {
    content,
    stopReason: hasToolCalls ? "tool_use" : "end_turn",
    usage: response.usage
      ? { input_tokens: response.usage.prompt_tokens, output_tokens: response.usage.completion_tokens }
      : undefined,
  };
}

function convertMessages(
  system: string,
  messages: NormalizedMessage[],
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
  ];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (
        Array.isArray(msg.content) &&
        msg.content.length > 0 &&
        (msg.content[0] as { type: string }).type === "tool_result"
      ) {
        const toolResults = msg.content as NormalizedToolResult[];
        for (const tr of toolResults) {
          result.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: tr.content,
          });
        }
      } else if (Array.isArray(msg.content)) {
        // Strip document blocks (OpenAI-compat doesn't accept them); keep text.
        const text = (msg.content as NormalizedContentBlock[])
          .filter((b): b is Extract<NormalizedContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        result.push({ role: "user", content: text });
      } else {
        result.push({ role: "user", content: msg.content as string });
      }
    } else {
      if (Array.isArray(msg.content)) {
        const blocks = msg.content as NormalizedContentBlock[];
        const textParts = blocks
          .filter((b): b is Extract<NormalizedContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        const toolCalls = blocks
          .filter((b): b is Extract<NormalizedContentBlock, { type: "tool_use" }> => b.type === "tool_use")
          .map((tu) => ({
            id: tu.id,
            type: "function" as const,
            function: { name: tu.name, arguments: JSON.stringify(tu.input) },
          }));

        result.push({
          role: "assistant",
          content: textParts || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      } else {
        result.push({ role: "assistant", content: msg.content as string });
      }
    }
  }

  return result;
}

function convertTools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function parseArguments(args: string): unknown {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}
