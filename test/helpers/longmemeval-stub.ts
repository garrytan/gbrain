/**
 * Shared stub MessagesClient for LongMemEval harness tests.
 *
 * Extracted from test/eval-longmemeval.slow.test.ts when the file was split
 * into pure-bucket + e2e-bucket halves to relieve CI shard wallclock. Both
 * halves import from here so the stub stays single-source-of-truth.
 *
 * Returns a canned answer text and records the prompt the caller built so
 * tests can assert on prompt-construction. No real Anthropic API calls.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ThinkLLMClient } from '../../src/core/think/index.ts';

export interface StubCall {
  model: string;
  system: string;
  userText: string;
}

export function makeStubClient(cannedText: string): { client: ThinkLLMClient; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const client: ThinkLLMClient = {
    async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
      const sys = typeof params.system === 'string'
        ? params.system
        : Array.isArray(params.system)
          ? params.system.map(b => (typeof b === 'string' ? b : (b as any).text ?? '')).join('\n')
          : '';
      const userMsg = params.messages[0];
      const userContent = typeof userMsg.content === 'string'
        ? userMsg.content
        : userMsg.content.map(b => (b.type === 'text' ? b.text : '')).join('\n');
      calls.push({ model: params.model, system: sys, userText: userContent });
      return {
        id: 'stub-msg-id',
        type: 'message',
        role: 'assistant',
        model: params.model,
        content: [{ type: 'text', text: cannedText, citations: null }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: null,
        },
        container: null,
      } as unknown as Anthropic.Message;
    },
  };
  return { client, calls };
}
