import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
    constructor(_opts: { apiKey: string; baseURL: string }) {}
  },
}));

import { createOpenAIProvider } from "./openai.js";
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

describe("OpenAIProvider", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("identifies itself and accepts native documents", () => {
    const p = createOpenAIProvider({ apiKey: "k" });
    expect(p.name).toBe("openai");
    expect(p.acceptsDocuments).toBe(true);
  });

  it("normalizes a text response", async () => {
    mockCreate.mockResolvedValueOnce(textCompletion("Hi there"));
    const p = createOpenAIProvider({ apiKey: "k" });
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
    const p = createOpenAIProvider({ apiKey: "k" });
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
    const p = createOpenAIProvider({ apiKey: "k" });
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
    const p = createOpenAIProvider({ apiKey: "k" });
    await expect(p.sendMessage(baseParams)).rejects.toBeInstanceOf(ApiError);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("classifies 401 as ApiAuthError", async () => {
    mockCreate.mockRejectedValueOnce(new HttpError(401, "Invalid API key"));
    const p = createOpenAIProvider({ apiKey: "k" });
    await expect(p.sendMessage(baseParams)).rejects.toBeInstanceOf(ApiAuthError);
  });

  it("classifies 429 as RateLimitError", async () => {
    mockCreate.mockRejectedValueOnce(new HttpError(429, "Too many requests"));
    const p = createOpenAIProvider({ apiKey: "k" });
    await expect(p.sendMessage(baseParams)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("classifies an unknown error as ApiError", async () => {
    mockCreate.mockRejectedValueOnce(new HttpError(500, "Internal server error"));
    const p = createOpenAIProvider({ apiKey: "k" });
    await expect(p.sendMessage(baseParams)).rejects.toBeInstanceOf(ApiError);
  });

  it("handles an empty choices array", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [], usage: undefined });
    const p = createOpenAIProvider({ apiKey: "k" });
    const res = await p.sendMessage(baseParams);
    expect(res.content).toEqual([]);
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage).toBeUndefined();
  });

  it("forwards a DocumentBlock as an OpenAI file content part", async () => {
    mockCreate.mockResolvedValueOnce(textCompletion("ok"));
    const p = createOpenAIProvider({ apiKey: "k" });
    await p.sendMessage({
      ...baseParams,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: "QkFTRTY0" },
              title: "statement.pdf",
            },
            { type: "text", text: "Parse this page." },
          ],
        },
      ],
    });

    const sent = mockCreate.mock.calls[0][0];
    const userMsg = sent.messages.find((m: { role: string }) => m.role === "user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content).toEqual([
      {
        type: "file",
        file: {
          filename: "statement.pdf",
          file_data: "data:application/pdf;base64,QkFTRTY0",
        },
      },
      { type: "text", text: "Parse this page." },
    ]);
  });

  it("keeps user content as a plain string when there is no attachment", async () => {
    mockCreate.mockResolvedValueOnce(textCompletion("ok"));
    const p = createOpenAIProvider({ apiKey: "k" });
    await p.sendMessage({
      ...baseParams,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });

    const sent = mockCreate.mock.calls[0][0];
    const userMsg = sent.messages.find((m: { role: string }) => m.role === "user");
    expect(userMsg.content).toBe("hello");
  });

  it("maps finish_reason=length to stopReason=max_tokens", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ finish_reason: "length", message: { content: "partial output" } }],
      usage: { prompt_tokens: 10, completion_tokens: 4096 },
    });
    const p = createOpenAIProvider({ apiKey: "k" });
    const res = await p.sendMessage(baseParams);
    expect(res.stopReason).toBe("max_tokens");
  });

  it("throws when a tool_call's arguments are not valid JSON", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: "length",
          message: {
            content: null,
            tool_calls: [
              {
                type: "function",
                id: "call_x",
                function: { name: "record_transactions", arguments: '{"rows":[{"date":"2025-' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4096 },
    });
    const p = createOpenAIProvider({ apiKey: "k" });
    await expect(p.sendMessage(baseParams)).rejects.toThrow(/record_transactions/);
  });
});
