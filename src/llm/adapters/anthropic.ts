/**
 * Anthropic Native Adapter
 *
 * Wraps `@anthropic-ai/sdk` behind the unified interface. Preserves:
 *   - Native `tool_use` / `tool_result` content blocks
 *   - Prompt caching via `cache_control` blocks (when requested)
 *   - Anthropic-specific rate-limit key handling
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  AIProvider,
  ChatParams,
  ChatResult,
  UnifiedContentBlock,
} from '../provider.ts';

export interface AnthropicAdapterOpts {
  apiKey: string;
  baseURL?: string;
}

export class AnthropicAdapter implements AIProvider {
  private client: Anthropic;

  constructor(opts: AnthropicAdapterOpts) {
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  }

  async chat(params: ChatParams, opts?: { signal?: AbortSignal }): Promise<ChatResult> {
    const systemBlocks: Anthropic.TextBlockParam[] | undefined = params.system
      ? [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }]
      : undefined;

    const tools: Anthropic.Tool[] | undefined = params.tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool['input_schema'],
    }));

    // Add cache_control to the last tool definition so Anthropic caches
    // everything up to and including that block.
    if (tools && tools.length > 0) {
      const last = tools[tools.length - 1];
      (last as any).cache_control = { type: 'ephemeral' };
    }

    const messages: Anthropic.MessageParam[] = params.messages.map(m => ({
      role: m.role,
      content: m.content as Anthropic.MessageParam['content'],
    }));

    const response = await this.client.messages.create(
      {
        model: params.model,
        max_tokens: params.max_tokens ?? 4096,
        ...(systemBlocks ? { system: systemBlocks as any } : {}),
        messages,
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      },
      { signal: opts?.signal },
    );

    const usage: ChatResult['usage'] = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read: (response.usage as any).cache_read_input_tokens ?? 0,
      cache_create: (response.usage as any).cache_creation_input_tokens ?? 0,
    };

    return {
      role: 'assistant',
      content: response.content as UnifiedContentBlock[],
      usage,
    };
  }

  async embed(_texts: string[]): Promise<Float32Array[]> {
    throw new Error('AnthropicAdapter does not support embeddings. Use getEmbeddingProvider() for embeddings.');
  }

  supportsFeature(feature: string): boolean {
    return feature === 'prompt_caching' || feature === 'native_tool_use';
  }
}
