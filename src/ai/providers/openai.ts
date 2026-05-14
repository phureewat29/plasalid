import OpenAI from "openai";
import type {
  Provider,
  SendMessageParams,
  NormalizedResponse,
  NormalizedContentBlock,
  NormalizedMessage,
  NormalizedToolResult,
  ToolDefinition,
} from "../provider.js";

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
      const messages = convertMessages(params.system, params.messages);
      const tools = convertTools(params.tools);

      // Try max_tokens first (broadest compat: Ollama, vLLM, older OpenAI models),
      // fall back to max_completion_tokens if rejected (newer OpenAI models require it)
      let response;
      try {
        response = await client.chat.completions.create(
          {
            model: params.model,
            max_tokens: params.maxTokens,
            messages,
            tools: tools.length > 0 ? tools : undefined,
          },
          { signal: params.signal },
        );
      } catch (e: any) {
        if (e.status === 400 && e.message?.includes("max_tokens")) {
          response = await client.chat.completions.create(
            {
              model: params.model,
              max_completion_tokens: params.maxTokens,
              messages,
              tools: tools.length > 0 ? tools : undefined,
            },
            { signal: params.signal },
          );
        } else {
          throw e;
        }
      }

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
      if (
        Array.isArray(msg.content) &&
        msg.content.length > 0 &&
        (msg.content[0] as any).type === "tool_result"
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
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join("\n");
        result.push({ role: "user", content: text });
      } else {
        result.push({ role: "user", content: msg.content as string });
      }
    } else {
      if (Array.isArray(msg.content)) {
        const blocks = msg.content as NormalizedContentBlock[];
        const textParts = blocks
          .filter((b) => b.type === "text")
          .map((b) => (b as any).text)
          .join("\n");
        const toolCalls = blocks
          .filter((b) => b.type === "tool_use")
          .map((b) => {
            const tu = b as Extract<NormalizedContentBlock, { type: "tool_use" }>;
            return {
              id: tu.id,
              type: "function" as const,
              function: { name: tu.name, arguments: JSON.stringify(tu.input) },
            };
          });

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

function parseArguments(args: string): any {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}
