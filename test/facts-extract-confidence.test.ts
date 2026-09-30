/**
 * B-16: the LLM extractor reads the confidence the model stated. A numeric
 * string ("0.3") used to become 1.0, maximum certainty. A missing or null
 * confidence keeps the legacy 1.0 unless `facts.extraction_missing_confidence`
 * opts into a lower value. Unknown kinds are counted in a warning instead of
 * being folded into 'fact' silently.
 *
 * Gateway chat-transport test seam — no API key, no network.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { extractFactsFromTurn } from '../src/core/facts/extract.ts';

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
});

afterAll(() => {
  __setChatTransportForTests(null);
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ...process.env } });
});

function reply(facts: unknown[]): void {
  const text = JSON.stringify({ facts });
  __setChatTransportForTests(async () => ({
    text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
  }) as ChatResult);
}

const configEngine = (config: Record<string, string>) =>
  ({ getConfig: async (key: string) => config[key] ?? null }) as unknown as BrainEngine;

describe('extractor confidence', () => {
  test('a numeric-string confidence is the stated value, not maximum certainty', async () => {
    reply([{ fact: 'might move to Berlin', kind: 'belief', confidence: '0.3', notability: 'medium' }]);
    const facts = await extractFactsFromTurn({ turnText: 'a hedged turn', source: 'test:confidence' });
    expect(facts.map(f => f.confidence)).toEqual([0.3]);
  });

  test('a missing confidence uses the opt-in configured value', async () => {
    reply([
      { fact: 'might move to Berlin', kind: 'belief', confidence: null, notability: 'medium' },
      { fact: 'likes tea', kind: 'preference', notability: 'medium' },
      { fact: 'works at Acme', kind: 'fact', confidence: 'very', notability: 'medium' },
    ]);
    const facts = await extractFactsFromTurn({
      turnText: 'a turn', source: 'test:confidence', embedding: null,
      engine: configEngine({ 'facts.extraction_missing_confidence': '0.5' }),
    });
    expect(facts.map(f => f.confidence)).toEqual([0.5, 0.5, 0.5]);
  });

  test('without the opt-in, a missing confidence keeps the legacy 1.0', async () => {
    reply([{ fact: 'likes tea', kind: 'preference', notability: 'medium' }]);
    const facts = await extractFactsFromTurn({ turnText: 'a turn', source: 'test:confidence', embedding: null, engine: configEngine({}) });
    expect(facts.map(f => f.confidence)).toEqual([1]);
  });
});
