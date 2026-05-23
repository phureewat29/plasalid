import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
    constructor(_opts: { apiKey: string; baseURL: string }) {}
  },
}));

import { createOpenAICompatProvider } from "./openai-compat.js";

const baseParams = {
  model: "qwen3-vl-7b",
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

describe("OpenAICompatProvider", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("identifies itself and refuses native documents", () => {
    const p = createOpenAICompatProvider({ apiKey: "k", baseURL: "http://x" });
    expect(p.name).toBe("openai-compat");
    expect(p.acceptsDocuments).toBe(false);
  });

  it("forwards an ImageBlock as an image_url content part", async () => {
    mockCreate.mockResolvedValueOnce(textCompletion("ok"));
    const p = createOpenAICompatProvider({ apiKey: "k", baseURL: "http://x" });
    await p.sendMessage({
      ...baseParams,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "QkFTRTY0" },
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
        type: "image_url",
        image_url: { url: "data:image/png;base64,QkFTRTY0" },
      },
      { type: "text", text: "Parse this page." },
    ]);
  });

  it("keeps user content as a plain string when there are no attachments", async () => {
    mockCreate.mockResolvedValueOnce(textCompletion("ok"));
    const p = createOpenAICompatProvider({ apiKey: "k", baseURL: "http://x" });
    await p.sendMessage({
      ...baseParams,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });

    const sent = mockCreate.mock.calls[0][0];
    const userMsg = sent.messages.find((m: { role: string }) => m.role === "user");
    expect(userMsg.content).toBe("hello");
  });

  it("throws loudly when a DocumentBlock reaches the provider", async () => {
    const p = createOpenAICompatProvider({ apiKey: "k", baseURL: "http://x" });
    await expect(
      p.sendMessage({
        ...baseParams,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: "QQ==" },
                title: "x.pdf",
              },
              { type: "text", text: "parse" },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/does not accept document blocks/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("maps finish_reason=length to stopReason=max_tokens", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ finish_reason: "length", message: { content: "partial" } }],
      usage: { prompt_tokens: 10, completion_tokens: 4096 },
    });
    const p = createOpenAICompatProvider({ apiKey: "k", baseURL: "http://x" });
    const res = await p.sendMessage(baseParams);
    expect(res.stopReason).toBe("max_tokens");
  });
});
