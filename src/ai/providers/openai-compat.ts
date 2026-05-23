import OpenAI from "openai";
import { classifyProviderError } from "../errors.js";
import type {
  Provider,
  SendMessageParams,
  NormalizedResponse,
  NormalizedContentBlock,
  NormalizedMessage,
} from "../provider.js";
import {
  convertAssistantMessage,
  convertToolResults,
  convertTools,
  createCompletionWithTokenFallback,
  isToolResultEnvelope,
  normalizeResponse,
} from "./openai.js";

/**
 * Generic Chat Completions client for LM Studio / Ollama / vLLM / etc.
 * `file` content parts are an OpenAI-only extension and are rejected here;
 * the scanner rasterizes PDFs to PNG and we ship `image_url` parts.
 */
export function createOpenAICompatProvider(opts: {
  apiKey: string;
  baseURL: string;
}): Provider {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
  });

  return {
    name: "openai-compat",
    supportsThinking: false,
    acceptsDocuments: false,

    async sendMessage(params: SendMessageParams): Promise<NormalizedResponse> {
      const tools = convertTools(params.tools);
      const body = {
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

function buildUserMessage(
  blocks: NormalizedContentBlock[],
): OpenAI.ChatCompletionUserMessageParam {
  for (const block of blocks) {
    if (block.type === "document") {
      throw new Error(
        "openai-compat does not accept document blocks. The scanner should rasterize PDFs to images for this provider — this is a bug.",
      );
    }
  }

  const hasImage = blocks.some((b) => b.type === "image");
  if (!hasImage) {
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
    } else if (block.type === "image") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      });
    }
  }
  return { role: "user", content: parts };
}
