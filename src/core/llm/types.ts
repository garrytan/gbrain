import type { ContentBlock, ToolDef } from '../minions/types.ts';

export type LLMProviderName = 'anthropic' | 'openai';

export interface LLMUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface LLMToolChoice {
  type: 'auto' | 'any' | 'tool';
  name?: string;
}

export interface LLMTool extends Pick<ToolDef, 'name' | 'description' | 'input_schema'> {
  /** Provider-specific prompt-cache hint; used by Anthropic and ignored by OpenAI. */
  cache_control?: unknown;
}

export interface LLMCreateParams {
  model: string;
  max_tokens: number;
  system?: string | Array<Record<string, unknown>>;
  messages: LLMMessage[];
  tools?: LLMTool[];
  tool_choice?: LLMToolChoice;
}

export interface LLMMessageResponse {
  id?: string;
  model?: string;
  content: ContentBlock[];
  stop_reason?: string | null;
  usage?: LLMUsage;
}

export interface LLMClient {
  provider: LLMProviderName;
  createMessage(params: LLMCreateParams, opts?: { signal?: AbortSignal }): Promise<LLMMessageResponse>;
}
