/**
 * Unified AI Provider Interface
 *
 * Abstracts chat completions with tool use and embeddings behind one
 * stable interface. All consumers (subagent, expansion, hybrid search,
 * operations) depend only on this interface.
 *
 * Types are intentionally close to Anthropic's shape to minimize
 * refactoring in the subagent loop, but are owned here so they are
 * not tied to any one provider.
 */

// ---------------------------------------------------------------------------
// Unified content blocks (structurally compatible with minions/types.ts)
// ---------------------------------------------------------------------------

export type UnifiedContentBlock =
  | { type: 'text'; text: string; [k: string]: unknown }
  | { type: 'tool_use'; id: string; name: string; input: unknown; [k: string]: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

export interface UnifiedMessage {
  role: 'user' | 'assistant';
  content: UnifiedContentBlock[];
}

export interface UnifiedTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ChatParams {
  model: string;
  messages: UnifiedMessage[];
  tools?: UnifiedTool[];
  system?: string;
  temperature?: number;
  max_tokens?: number;
  signal?: AbortSignal;
}

export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read?: number;
  cache_create?: number;
}

export interface ChatResult {
  role: 'assistant';
  content: UnifiedContentBlock[];
  usage?: ChatUsage;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface AIProvider {
  /** Chat completion with tool use. Streaming not required for v1. */
  chat(params: ChatParams, opts?: { signal?: AbortSignal }): Promise<ChatResult>;

  /** Batch embedding generation. Returns one vector per input text. */
  embed(texts: string[]): Promise<Float32Array[]>;

  /** Feature flags (e.g., 'prompt_caching', 'native_tool_use'). */
  supportsFeature(feature: string): boolean;
}
