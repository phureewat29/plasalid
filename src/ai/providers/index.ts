import type { Provider } from "../provider.js";
import { config } from "../../config.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAICompatibleProvider } from "./openai.js";

export function createProvider(): Provider {
  if (config.providerType === "openai-compatible") {
    return createOpenAICompatibleProvider({
      apiKey: config.openaiCompatibleKey || "openai-compatible",
      baseURL: config.openaiCompatibleBaseURL,
    });
  }
  return createAnthropicProvider({ apiKey: config.anthropicKey });
}
