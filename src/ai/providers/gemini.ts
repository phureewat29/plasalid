import { GoogleGenAI } from "@google/genai";
import type {
  Content,
  FinishReason,
  GenerateContentResponse,
  Part,
  Tool,
} from "@google/genai";
import { classifyProviderError } from "../errors.js";
import type {
  NormalizedContentBlock,
  NormalizedMessage,
  NormalizedResponse,
  NormalizedToolResult,
  Provider,
  SendMessageParams,
  ToolDefinition,
} from "../provider.js";

/**
 * Native Gemini provider that talks to Google's GenAI API. Required because
 * Gemini's OpenAI-compat shim rejects PDF `file` content parts; the native
 * API accepts them as `inlineData` with mimeType `application/pdf`.
 *
 * supportsThinking is `false` because Gemini 2.5+ runs thinking server-side
 * automatically — we don't need a client-side budget like Claude's extended
 * thinking, and the agent's thinkingBudget config still controls whether we
 * raise maxTokens for the thinking path even on providers that ignore it.
 */
export function createGeminiProvider(opts: { apiKey: string }): Provider {
  const client = new GoogleGenAI({ apiKey: opts.apiKey });

  return {
    name: "gemini",
    supportsThinking: false,
    acceptsDocuments: true,

    async sendMessage(params: SendMessageParams): Promise<NormalizedResponse> {
      try {
        const response = await client.models.generateContent({
          model: params.model,
          contents: convertMessages(params.messages),
          config: {
            systemInstruction: params.system,
            tools: convertTools(params.tools),
            maxOutputTokens: params.maxTokens,
            abortSignal: params.signal,
          },
        });
        return normalizeResponse(response);
      } catch (e) {
        classifyProviderError(e, params.signal);
      }
    },
  };
}

function convertMessages(messages: NormalizedMessage[]): Content[] {
  const result: Content[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (
        Array.isArray(msg.content) &&
        msg.content.length > 0 &&
        (msg.content[0] as { type: string }).type === "tool_result"
      ) {
        const toolResults = msg.content as NormalizedToolResult[];
        result.push({
          role: "user",
          parts: toolResults.map((tr) => ({
            functionResponse: {
              id: tr.tool_use_id,
              name: extractToolName(tr.tool_use_id),
              response: { content: tr.content },
            },
          })),
        });
      } else if (Array.isArray(msg.content)) {
        result.push({
          role: "user",
          parts: blocksToParts(msg.content as NormalizedContentBlock[]),
        });
      } else {
        result.push({ role: "user", parts: [{ text: msg.content as string }] });
      }
    } else {
      if (Array.isArray(msg.content)) {
        result.push({
          role: "model",
          parts: blocksToParts(msg.content as NormalizedContentBlock[]),
        });
      } else {
        result.push({
          role: "model",
          parts: [{ text: msg.content as string }],
        });
      }
    }
  }
  return result;
}

function blocksToParts(blocks: NormalizedContentBlock[]): Part[] {
  const parts: Part[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push({ text: block.text });
    } else if (block.type === "document") {
      parts.push({
        inlineData: {
          mimeType: block.source.media_type,
          data: block.source.data,
        },
      });
    } else if (block.type === "tool_use") {
      const part: Part = {
        functionCall: {
          id: block.id,
          name: block.name,
          args: (block.input ?? {}) as Record<string, unknown>,
        },
      };
      // Gemini 2.5+ requires thought_signature to be echoed back on every
      // assistant turn that carries function calls — otherwise the next API
      // call fails with INVALID_ARGUMENT.
      if (block.thoughtSignature) {
        part.thoughtSignature = block.thoughtSignature;
      }
      parts.push(part);
    }
  }
  return parts;
}

function convertTools(tools: ToolDefinition[]): Tool[] | undefined {
  if (tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        // Gemini accepts a raw JSON Schema via parametersJsonSchema; our
        // ToolDefinition.input_schema is already in that shape, so it goes
        // through without translation.
        parametersJsonSchema: t.input_schema,
      })),
    },
  ];
}

/**
 * Gemini IDs tool calls with synthetic strings like `${name}-${index}` when
 * the model doesn't return one. We embed the tool name in the ID so that the
 * follow-up functionResponse part can recover it — Gemini requires a `name`
 * field on every functionResponse, and the tool result message we receive
 * from the agent only carries the tool_use_id.
 */
function extractToolName(toolUseId: string): string {
  const dash = toolUseId.lastIndexOf("-");
  return dash > 0 ? toolUseId.slice(0, dash) : toolUseId;
}

function normalizeResponse(
  response: GenerateContentResponse,
): NormalizedResponse {
  const candidate = response.candidates?.[0];
  const content: NormalizedContentBlock[] = [];
  let toolIndex = 0;
  for (const part of candidate?.content?.parts ?? []) {
    if (part.thought) continue;
    if (typeof part.text === "string" && part.text.length > 0) {
      content.push({ type: "text", text: part.text });
    } else if (part.functionCall) {
      const name = part.functionCall.name ?? "unknown";
      content.push({
        type: "tool_use",
        id: part.functionCall.id ?? `${name}-${toolIndex}`,
        name,
        input: part.functionCall.args ?? {},
        ...(part.thoughtSignature
          ? { thoughtSignature: part.thoughtSignature }
          : {}),
      });
      toolIndex++;
    }
  }

  const hasToolCalls = content.some((b) => b.type === "tool_use");
  // Read finishReason even when content.parts is missing — that happens when
  // a thinking model burns the entire output budget on thoughts (parts=[] +
  // finishReason=MAX_TOKENS). Falling through to "end_turn" would hide that.
  const stopReason = mapFinishReason(candidate?.finishReason, hasToolCalls);

  const usage = response.usageMetadata
    ? {
        input_tokens: response.usageMetadata.promptTokenCount ?? 0,
        output_tokens: response.usageMetadata.candidatesTokenCount ?? 0,
      }
    : undefined;

  return { content, stopReason, ...(usage ? { usage } : {}) };
}

function mapFinishReason(
  reason: FinishReason | undefined,
  hasToolCalls: boolean,
): string {
  if (reason === "MAX_TOKENS") return "max_tokens";
  if (hasToolCalls) return "tool_use";
  return "end_turn";
}
