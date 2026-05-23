import type { Provider } from "../provider.js";
import { config } from "../../config.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";
import { createOpenAICompatProvider } from "./openai-compat.js";
import { createGeminiProvider } from "./gemini.js";

let cached: Provider | null = null;

function buildProvider(): Provider {
  switch (config.providerType) {
    case "anthropic":
      return createAnthropicProvider({ apiKey: config.anthropicKey });
    case "openai":
      return createOpenAIProvider({ apiKey: config.openaiKey });
    case "gemini":
      return createGeminiProvider({ apiKey: config.geminiKey });
    case "openai-compat":
      return createOpenAICompatProvider({
        apiKey: config.openaiCompatKey || "openai-compat",
        baseURL: config.openaiCompatBaseURL,
      });
  }
}

/** Singleton so agent.ts and the scanner share one provider instance. */
export function getProvider(): Provider {
  if (cached === null) cached = buildProvider();
  return cached;
}
