/**
 * OpenAI-Compatible Adapter
 *
 * Wraps the `openai` SDK with configurable `baseURL`. Handles any provider
 * that speaks OpenAI Chat Completions / Embeddings (OpenAI, DeepSeek,
 * Groq, Azure, local proxies, Ollama).
 */

import OpenAI from 'openai';
import type {
  AIProvider,
  ChatParams,
  ChatResult,
  UnifiedContentBlock,
  UnifiedMessage,
} from '../provider.ts';

export interface OpenAICompatibleOpts {
  apiKey: string;
  baseURL?: string;
  model: string;
  dimensions?: number;
}

export class OpenAICompatibleAdapter implements AIProvider {
  private client: OpenAI;
  private model: string;
  private dimensions?: number;

  constructor(opts: OpenAICompatibleOpts) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.model = opts.model;
    this.dimensions = opts.dimensions;
  }

  async chat(params: ChatParams, opts?: { signal?: AbortSignal }): Promise<ChatResult> {
    const messages: OpenAI.ChatCompletionMessageParam[] = this.flattenMessages(
      params.messages,
    );

    // Prepend system message if provided
    if (params.system) {
      messages.unshift({ role: 'system', content: params.system });
    }

    const tools: OpenAI.ChatCompletionTool[] | undefined = params.tools?.map(
      t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }),
    );

    const response = await this.client.chat.completions.create(
      {
        model: params.model,
        messages,
        ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
        ...(params.temperature !== undefined
          ? { temperature: params.temperature }
          : {}),
        ...(params.max_tokens !== undefined
          ? { max_tokens: params.max_tokens }
          : {}),
      },
      { signal: opts?.signal },
    );

    const choice = response.choices[0];
    if (!choice) {
      throw new Error('OpenAI-compatible provider returned empty choices');
    }

    const content = this.fromOpenAIMessage(choice.message);
    const usage = response.usage
      ? {
          input_tokens: response.usage.prompt_tokens,
          output_tokens: response.usage.completion_tokens,
        }
      : undefined;

    return {
      role: 'assistant',
      content,
      usage,
    };
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const params: OpenAI.Embeddings.EmbeddingCreateParams = {
      model: this.model,
      input: texts,
    };
    if (this.dimensions != null) {
      (params as any).dimensions = this.dimensions;
    }

    const response = await this.client.embeddings.create(params);

    const sorted = response.data.sort((a, b) => a.index - b.index);
    return sorted.map(d => new Float32Array(d.embedding));
  }

  supportsFeature(_feature: string): boolean {
    // OpenAI-compatible adapters do not support Anthropic-specific
    // features like prompt caching via cache_control blocks.
    return false;
  }

  // ── Internal: mapping ───────────────────────────────────────

  /**
   * Flatten unified messages into OpenAI's message format.
   *
   * OpenAI requires each tool_result to be a separate `role: 'tool'`
   * message with a single `tool_call_id`. The subagent loop sends a
   * synthesized user turn with multiple tool_result blocks; we expand
   * those here so the adapter handles the format gap transparently.
   */
  private flattenMessages(
    messages: UnifiedMessage[],
  ): OpenAI.ChatCompletionMessageParam[] {
    const out: OpenAI.ChatCompletionMessageParam[] = [];

    for (const m of messages) {
      const toolResults = m.content.filter(
        (b): b is { type: 'tool_result'; tool_use_id: string; content: unknown } =>
          b.type === 'tool_result',
      );
      const otherBlocks = m.content.filter(b => b.type !== 'tool_result');

      // Emit tool results as separate 'tool' messages
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: this.stringifyToolResult(tr.content),
        });
      }

      // Emit remaining blocks as a single assistant/user message
      if (otherBlocks.length > 0) {
        if (m.role === 'assistant') {
          const textParts = otherBlocks
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map(b => b.text);
          const toolCalls = otherBlocks
            .filter(
              (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } =>
                b.type === 'tool_use',
            )
            .map(b => ({
              id: b.id,
              type: 'function' as const,
              function: {
                name: b.name,
                arguments: JSON.stringify(b.input ?? {}),
              },
            }));

          out.push({
            role: 'assistant',
            content: textParts.join('\n') || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        } else {
          const textParts = otherBlocks
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map(b => b.text);
          out.push({
            role: m.role,
            content: textParts.join('\n'),
          });
        }
      }
    }

    return out;
  }

  private fromOpenAIMessage(
    msg: OpenAI.ChatCompletionMessage,
  ): UnifiedContentBlock[] {
    const blocks: UnifiedContentBlock[] = [];

    if (msg.content) {
      blocks.push({ type: 'text', text: msg.content });
    }

    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.type === 'function') {
          let input: unknown;
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = tc.function.arguments;
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }
    }

    return blocks;
  }

  private stringifyToolResult(content: unknown): string {
    if (typeof content === 'string') return content;
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
}
