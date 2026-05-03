import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionToolChoiceOption } from 'openai/resources/chat/completions';
import type { ContentBlock } from '../../minions/types.ts';
import type { LLMClient, LLMCreateParams, LLMMessageResponse } from '../types.ts';

function flattenSystem(system: LLMCreateParams['system']): string | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') return system;
  return system.map(b => typeof b.text === 'string' ? b.text : '').filter(Boolean).join('\n\n') || undefined;
}

function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .map(b => {
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      if (b.type === 'tool_result') return typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function toOpenAIMessages(params: LLMCreateParams): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  const sys = flattenSystem(params.system);
  if (sys) out.push({ role: 'system', content: sys });

  for (const m of params.messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const toolUses = m.content.filter((b): b is ContentBlock & { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use');
    const toolResults = m.content.filter((b): b is ContentBlock & { type: 'tool_result'; tool_use_id: string; content: unknown } => b.type === 'tool_result');
    const text = blocksToText(m.content);

    if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolUses.length > 0 ? {
          tool_calls: toolUses.map(t => ({
            id: t.id,
            type: 'function' as const,
            function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
          })),
        } : {}),
      });
    } else if (toolResults.length > 0) {
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content ?? null),
        });
      }
      const extraText = m.content.filter(b => b.type === 'text');
      if (extraText.length > 0) out.push({ role: 'user', content: blocksToText(extraText) });
    } else {
      out.push({ role: 'user', content: text });
    }
  }
  return out;
}

function toOpenAITools(tools: LLMCreateParams['tools']): ChatCompletionTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function toToolChoice(choice: LLMCreateParams['tool_choice']): ChatCompletionToolChoiceOption | undefined {
  if (!choice) return undefined;
  if (choice.type === 'tool' && choice.name) return { type: 'function', function: { name: choice.name } };
  if (choice.type === 'any') return 'required';
  return 'auto';
}

function parseArgs(raw: string): unknown {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

export class OpenAILLMClient implements LLMClient {
  readonly provider = 'openai' as const;
  private readonly client: OpenAI;

  constructor(client = new OpenAI()) {
    this.client = client;
  }

  static fromConfig(config?: { openai_api_key?: string }): OpenAILLMClient {
    return new OpenAILLMClient(new OpenAI({ apiKey: config?.openai_api_key }));
  }

  async createMessage(params: LLMCreateParams, opts?: { signal?: AbortSignal }): Promise<LLMMessageResponse> {
    const resp = await this.client.chat.completions.create({
      model: params.model,
      max_tokens: params.max_tokens,
      messages: toOpenAIMessages(params),
      tools: toOpenAITools(params.tools),
      tool_choice: toToolChoice(params.tool_choice),
    }, opts);

    const choice = resp.choices[0];
    const message = choice?.message;
    const content: ContentBlock[] = [];
    if (message?.content) content.push({ type: 'text', text: message.content });
    for (const call of message?.tool_calls ?? []) {
      if (call.type !== 'function') continue;
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: parseArgs(call.function.arguments),
      });
    }

    return {
      id: resp.id,
      model: resp.model,
      content,
      stop_reason: choice?.finish_reason ?? null,
      usage: resp.usage ? {
        input_tokens: resp.usage.prompt_tokens,
        output_tokens: resp.usage.completion_tokens,
      } : undefined,
    };
  }
}
