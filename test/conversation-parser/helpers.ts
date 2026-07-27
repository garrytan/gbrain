/**
 * v0.41.16.0 — Test helpers for conversation-parser unit tests.
 *
 * `makeChatResult(text)` builds a fully-typed `ChatResult` stub so
 * test transports satisfy the gateway's type contract without each
 * test repeating the empty fields.
 */

import type { ChatResult } from '../../src/core/ai/gateway.ts';

export function makeChatResult(
  text: string,
  usage = { input_tokens: 10, output_tokens: 30 },
): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  };
}
