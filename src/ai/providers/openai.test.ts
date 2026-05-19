import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
    constructor(_opts: { apiKey: string; baseURL: string }) {}
  },
}));

import { createOpenAICompatibleProvider } from "./openai.js";
import { ApiAuthError, ApiError, RateLimitError } from "../errors.js";

const baseParams = {
  model: "gpt-4o-mini",
  system: "You are a test assistant",
  messages: [{ role: "user" as const, content: "hello" }],
  tools: [],
  maxTokens: 4096,
};

function textCompletion(text: string) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

describe("OpenAICompatibleProvider", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("has correct name", () => {
    const p = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "http://x" });
    expect(p.name).toBe("openai-compatible");
  });

  it("normalizes a text response", async () => {
    mockCreate.mockResolvedValueOnce(textCompletion("Hi there"));
    const p = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "http://x" });
    const res = await p.sendMessage(baseParams);
    expect(res.content).toEqual([{ type: "text", text: "Hi there" }]);
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("normalizes tool_calls into tool_use blocks", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: "let me check",
            tool_calls: [
              {
                type: "function",
                id: "call_1",
                function: { name: "get_balance", arguments: '{"account":"main"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    });
    const p = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "http://x" });
    const res = await p.sendMessage(baseParams);
    expect(res.content).toEqual([
      { type: "text", text: "let me check" },
      { type: "tool_use", id: "call_1", name: "get_balance", input: { account: "main" } },
    ]);
    expect(res.stopReason).toBe("tool_use");
  });

  it("retries with max_completion_tokens when 400 names max_tokens", async () => {
    mockCreate
      .mockRejectedValueOnce(new HttpError(400, "Unsupported parameter: 'max_tokens'"))
      .mockResolvedValueOnce(textCompletion("ok"));
    const p = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "http://x" });
    const res = await p.sendMessage(baseParams);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    const firstCall = mockCreate.mock.calls[0][0];
    const secondCall = mockCreate.mock.calls[1][0];
    expect(firstCall.max_tokens).toBe(4096);
    expect(firstCall.max_completion_tokens).toBeUndefined();
    expect(secondCall.max_completion_tokens).toBe(4096);
    expect(secondCall.max_tokens).toBeUndefined();
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("does not retry on a 400 that names a different parameter", async () => {
    mockCreate.mockRejectedValueOnce(new HttpError(400, "Invalid value for temperature"));
    const p = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "http://x" });
    await expect(p.sendMessage(baseParams)).rejects.toBeInstanceOf(ApiError);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("classifies 401 as ApiAuthError", async () => {
    mockCreate.mockRejectedValueOnce(new HttpError(401, "Invalid API key"));
    const p = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "http://x" });
    await expect(p.sendMessage(baseParams)).rejects.toBeInstanceOf(ApiAuthError);
  });

  it("classifies 429 as RateLimitError", async () => {
    mockCreate.mockRejectedValueOnce(new HttpError(429, "Too many requests"));
    const p = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "http://x" });
    await expect(p.sendMessage(baseParams)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("classifies an unknown error as ApiError", async () => {
    mockCreate.mockRejectedValueOnce(new HttpError(500, "Internal server error"));
    const p = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "http://x" });
    await expect(p.sendMessage(baseParams)).rejects.toBeInstanceOf(ApiError);
  });

  it("handles an empty choices array", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [], usage: undefined });
    const p = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "http://x" });
    const res = await p.sendMessage(baseParams);
    expect(res.content).toEqual([]);
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage).toBeUndefined();
  });
});
