import Anthropic from '@anthropic-ai/sdk';
import type { LLMClient, LLMCreateParams, LLMMessageResponse } from '../types.ts';
import type { ContentBlock } from '../../minions/types.ts';

export class AnthropicLLMClient implements LLMClient {
  readonly provider = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(client = new Anthropic()) {
    this.client = client;
  }

  static fromConfig(config?: { anthropic_api_key?: string }): AnthropicLLMClient {
    return new AnthropicLLMClient(new Anthropic({ apiKey: config?.anthropic_api_key }));
  }

  async createMessage(params: LLMCreateParams, opts?: { signal?: AbortSignal }): Promise<LLMMessageResponse> {
    const msg = await this.client.messages.create({
      model: params.model,
      max_tokens: params.max_tokens,
      system: params.system as Anthropic.MessageCreateParamsNonStreaming['system'],
      messages: params.messages as Anthropic.MessageCreateParamsNonStreaming['messages'],
      tools: params.tools?.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
        ...(t.cache_control ? { cache_control: t.cache_control as any } : {}),
      })),
      tool_choice: params.tool_choice as Anthropic.MessageCreateParamsNonStreaming['tool_choice'],
    }, opts);

    return {
      id: msg.id,
      model: msg.model,
      content: msg.content as ContentBlock[],
      stop_reason: msg.stop_reason ?? null,
      usage: msg.usage,
    };
  }
}
