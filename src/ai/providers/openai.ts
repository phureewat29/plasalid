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

const OPENAI_BASE_URL = "https://api.openai.com/v1";

export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
type NonStreamingParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type RequestOptions = Parameters<OpenAI["chat"]["completions"]["create"]>[1];

export interface CompletionBody {
  model: string;
  maxTokens: number;
  messages: OpenAI.ChatCompletionMessageParam[];
  tools: OpenAI.ChatCompletionTool[] | undefined;
}

export function createOpenAIProvider(opts: { apiKey: string }): Provider {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: OPENAI_BASE_URL,
  });

  return {
    name: "openai",
    supportsThinking: false,
    acceptsDocuments: true,

    async sendMessage(params: SendMessageParams): Promise<NormalizedResponse> {
      const tools = convertTools(params.tools);
      const body: CompletionBody = {
        model: params.model,
        maxTokens: params.maxTokens,
        messages: convertMessages(params.system, params.messages),
        tools: tools.length > 0 ? tools : undefined,
      };

      let response;
      try {
        response = await createCompletionWithTokenFallback(client, body, { signal: params.signal });
      } catch (e) {
        classifyProviderError(e, params.signal);
      }

      return normalizeResponse(response);
    },
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
      if (isToolResultEnvelope(msg.content)) {
        result.push(...convertToolResults(msg.content));
      } else if (Array.isArray(msg.content)) {
        result.push(buildUserMessage(msg.content as NormalizedContentBlock[]));
      } else {
        result.push({ role: "user", content: msg.content as string });
      }
    } else {
      if (Array.isArray(msg.content)) {
        result.push(convertAssistantMessage(msg.content as NormalizedContentBlock[]));
      } else {
        result.push({ role: "assistant", content: msg.content as string });
      }
    }
  }

  return result;
}

/** Real OpenAI accepts `file` parts for PDFs and `image_url` for images. */
function buildUserMessage(
  blocks: NormalizedContentBlock[],
): OpenAI.ChatCompletionUserMessageParam {
  const hasAttachment = blocks.some((b) => b.type === "document" || b.type === "image");
  if (!hasAttachment) {
    const text = blocks
      .filter((b): b is Extract<NormalizedContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return { role: "user", content: text };
  }

  const parts: OpenAI.ChatCompletionContentPart[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "document") {
      parts.push({
        type: "file",
        file: {
          filename: block.title ?? "document.pdf",
          file_data: `data:${block.source.media_type};base64,${block.source.data}`,
        },
      });
    } else if (block.type === "image") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      });
    }
  }
  return { role: "user", content: parts };
}

/* ------------------------------------------------------------------ */
/*  Shared helpers: also imported by openai-compat.ts.                */
/* ------------------------------------------------------------------ */

function isMaxTokensRejection(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  return err.status === 400 && (err.message?.includes("max_tokens") ?? false);
}

/**
 * Older models accept `max_tokens`; o-series / gpt-5+ require
 * `max_completion_tokens`. Try the former, fall back on the 400.
 */
export async function createCompletionWithTokenFallback(
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

export function normalizeResponse(response: ChatCompletion): NormalizedResponse {
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
        input: parseArguments(tc.function.name, tc.function.arguments),
      });
    }
  }

  const hasToolCalls = content.some((b) => b.type === "tool_use");
  /**
   * finish_reason "length" → "max_tokens" so the agent loop records a
   * scan_truncated question instead of silently accepting a partial batch.
   */
  const stopReason =
    choice.finish_reason === "length"
      ? "max_tokens"
      : hasToolCalls
        ? "tool_use"
        : "end_turn";

  return {
    content,
    stopReason,
    usage: response.usage
      ? { input_tokens: response.usage.prompt_tokens, output_tokens: response.usage.completion_tokens }
      : undefined,
  };
}

export function convertTools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/**
 * Throw on malformed JSON so truncated tool args surface as an error instead
 * of being silently coerced to `{}` (which would record zero transactions).
 */
export function parseArguments(toolName: string, args: string): unknown {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    const preview = args.length > 120 ? `${args.slice(0, 120)}…` : args;
    throw new Error(
      `Tool call arguments for "${toolName}" were not valid JSON (likely truncated by max_tokens): ${preview}`,
    );
  }
}

export function convertToolResults(
  toolResults: NormalizedToolResult[],
): OpenAI.ChatCompletionToolMessageParam[] {
  return toolResults.map((tr) => ({
    role: "tool",
    tool_call_id: tr.tool_use_id,
    content: tr.content,
  }));
}

export function convertAssistantMessage(
  blocks: NormalizedContentBlock[],
): OpenAI.ChatCompletionAssistantMessageParam {
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

  return {
    role: "assistant",
    content: textParts || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

export function isToolResultEnvelope(
  content: NormalizedMessage["content"],
): content is NormalizedToolResult[] {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    (content[0] as { type: string }).type === "tool_result"
  );
}
