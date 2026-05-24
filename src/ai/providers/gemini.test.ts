import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGenerateContent = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: mockGenerateContent };
    constructor(_opts: { apiKey: string }) {}
  },
}));

import { createGeminiProvider } from "./gemini.js";
import { ApiAuthError, ApiError, RateLimitError } from "../errors.js";

const baseParams = {
  model: "gemini-2.5-pro",
  system: "You are a test assistant",
  messages: [{ role: "user" as const, content: "hello" }],
  tools: [],
  maxTokens: 4096,
};

function textResponse(text: string) {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  };
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

describe("GeminiProvider", () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
  });

  it("has correct name and supportsThinking", () => {
    const p = createGeminiProvider({ apiKey: "k" });
    expect(p.name).toBe("gemini");
    expect(p.supportsThinking).toBe(false);
  });

  it("normalizes a text response", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse("Hi there"));
    const p = createGeminiProvider({ apiKey: "k" });
    const res = await p.sendMessage(baseParams);
    expect(res.content).toEqual([{ type: "text", text: "Hi there" }]);
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("forwards system prompt and maxOutputTokens via config", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse("ok"));
    const p = createGeminiProvider({ apiKey: "k" });
    await p.sendMessage(baseParams);
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.model).toBe("gemini-2.5-pro");
    expect(call.config.systemInstruction).toBe("You are a test assistant");
    expect(call.config.maxOutputTokens).toBe(4096);
  });

  it("forwards a DocumentBlock as an inlineData part", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse("ok"));
    const p = createGeminiProvider({ apiKey: "k" });
    await p.sendMessage({
      ...baseParams,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "QkFTRTY0",
              },
              title: "statement.pdf",
            },
            { type: "text", text: "Parse this page." },
          ],
        },
      ],
    });

    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.contents).toEqual([
      {
        role: "user",
        parts: [
          {
            inlineData: { mimeType: "application/pdf", data: "QkFTRTY0" },
          },
          { text: "Parse this page." },
        ],
      },
    ]);
  });

  it("translates a tool definition into functionDeclarations", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse("ok"));
    const p = createGeminiProvider({ apiKey: "k" });
    await p.sendMessage({
      ...baseParams,
      tools: [
        {
          name: "get_balance",
          description: "Get account balance",
          input_schema: {
            type: "object",
            properties: { account: { type: "string" } },
            required: ["account"],
          },
        },
      ],
    });
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.config.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "get_balance",
            description: "Get account balance",
            parametersJsonSchema: {
              type: "object",
              properties: { account: { type: "string" } },
              required: ["account"],
            },
          },
        ],
      },
    ]);
  });

  it("normalizes a functionCall into a tool_use block", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "let me check" },
              {
                functionCall: {
                  id: "call_1",
                  name: "get_balance",
                  args: { account: "main" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 },
    });
    const p = createGeminiProvider({ apiKey: "k" });
    const res = await p.sendMessage(baseParams);
    expect(res.content).toEqual([
      { type: "text", text: "let me check" },
      {
        type: "tool_use",
        id: "call_1",
        name: "get_balance",
        input: { account: "main" },
      },
    ]);
    expect(res.stopReason).toBe("tool_use");
  });

  it("synthesizes a tool_use id when the model omits one", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { functionCall: { name: "record_transactions", args: {} } },
            ],
          },
          finishReason: "STOP",
        },
      ],
    });
    const p = createGeminiProvider({ apiKey: "k" });
    const res = await p.sendMessage(baseParams);
    expect(res.content[0]).toMatchObject({
      type: "tool_use",
      name: "record_transactions",
      id: "record_transactions-0",
    });
  });

  it("maps FinishReason MAX_TOKENS to stopReason max_tokens", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "partial output" }] },
          finishReason: "MAX_TOKENS",
        },
      ],
    });
    const p = createGeminiProvider({ apiKey: "k" });
    const res = await p.sendMessage(baseParams);
    expect(res.stopReason).toBe("max_tokens");
  });

  it("classifies 401 as ApiAuthError", async () => {
    mockGenerateContent.mockRejectedValueOnce(new HttpError(401, "no key"));
    const p = createGeminiProvider({ apiKey: "k" });
    await expect(p.sendMessage(baseParams)).rejects.toBeInstanceOf(
      ApiAuthError,
    );
  });

  it("classifies 429 as RateLimitError", async () => {
    mockGenerateContent.mockRejectedValueOnce(
      new HttpError(429, "rate limit"),
    );
    const p = createGeminiProvider({ apiKey: "k" });
    await expect(p.sendMessage(baseParams)).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it("classifies 500 as ApiError", async () => {
    mockGenerateContent.mockRejectedValueOnce(new HttpError(500, "boom"));
    const p = createGeminiProvider({ apiKey: "k" });
    await expect(p.sendMessage(baseParams)).rejects.toBeInstanceOf(ApiError);
  });

  it("translates tool_result back into a functionResponse part", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse("ok"));
    const p = createGeminiProvider({ apiKey: "k" });
    await p.sendMessage({
      ...baseParams,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "record_transactions-0",
              content: "wrote 3 transactions",
            },
          ],
        },
      ],
    });
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.contents).toEqual([
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "record_transactions-0",
              name: "record_transactions",
              response: { content: "wrote 3 transactions" },
            },
          },
        ],
      },
    ]);
  });
});
