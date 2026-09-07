/**
 * gateway-client.ts — the `ThinkLLMClient` adapter over the configured AI
 * gateway used by BOTH chat lanes of `gbrain eval longmemeval` (the reader's
 * answer generation and the trajectory claim extractor). Peeled from
 * src/commands/eval-longmemeval.ts.
 *
 * INVARIANT (#4636): every call routes through `gateway.chat` — the same
 * provider routing the rest of the brain uses. `gateway.chat` parses
 * `provider:model` recipe ids, so a resolved id passes through UN-stripped
 * (normalized, never reduced to a bare model name).
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ThinkLLMClient } from '../../core/think/index.ts';
import { chat as gatewayChat } from '../../core/ai/gateway.ts';
import { normalizeModelId } from '../../core/model-id.ts';

export function makeGatewayThinkClient(): ThinkLLMClient {
  return {
    create: async (params) => {
      const system = typeof params.system === 'string'
        ? params.system
        : Array.isArray(params.system)
          ? params.system.map(b => ('text' in b ? b.text : '')).join('')
          : undefined;
      const messages = params.messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map(b => ('text' in b ? b.text : '')).join('')
            : '',
      }));
      const result = await gatewayChat({
        model: normalizeModelId(params.model),
        system,
        messages,
        maxTokens: params.max_tokens,
      });
      return {
        id: '',
        type: 'message',
        role: 'assistant',
        // The provider-reported snapshot id (D30) when the SDK surfaced one,
        // else the requested id — mirrors what the Anthropic SDK's `message.model` carries.
        model: result.responseModel ?? result.model,
        content: [{ type: 'text', text: result.text }],
        usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
        stop_reason: result.stopReason === 'length' ? 'max_tokens' : 'end_turn',
      } as unknown as Anthropic.Message;
    },
  };
}
