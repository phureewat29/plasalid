import type { Provider } from "../provider.js";
import { config } from "../../config.js";
import { createAnthropicProvider } from "./anthropic.js";

export function createProvider(): Provider {
  return createAnthropicProvider({ apiKey: config.anthropicKey });
}
