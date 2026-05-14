/**
 * Normalized types for provider abstraction.
 * Mirrors Anthropic's content-block shape but decoupled from the SDK types.
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: any;
}

export interface DocumentBlock {
  type: "document";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
  title?: string;
}

export type NormalizedContentBlock = TextBlock | ToolUseBlock | DocumentBlock;

export interface NormalizedResponse {
  content: NormalizedContentBlock[];
  stopReason: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface NormalizedMessage {
  role: "user" | "assistant";
  content: string | NormalizedContentBlock[] | NormalizedToolResult[];
}

export interface NormalizedToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, any>;
    required: string[];
  };
}

export interface SendMessageParams {
  model: string;
  system: string;
  messages: NormalizedMessage[];
  tools: ToolDefinition[];
  maxTokens: number;
  thinking?: { type: "enabled"; budget_tokens: number };
  signal?: AbortSignal;
}

export interface Provider {
  name: string;
  supportsThinking: boolean;
  sendMessage(params: SendMessageParams): Promise<NormalizedResponse>;
}
