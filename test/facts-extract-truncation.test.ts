/**
 * #2113 — facts extraction must not silently extract zero facts on truncation.
 *
 * Pre-fix, extractFactsFromTurn hardcoded maxTokens:1500 and never checked
 * the finish reason. Mandatory-reasoning models spend thinking tokens inside
 * the same cap, so the JSON payload got cut off, parse failed, and extraction
 * returned [] with no signal.
 *
 * Post-fix: the cap is configurable (`facts.extraction_max_tokens`, default
 * 4000), a stopReason:'length' response is retried once at double the cap,
 * and a still-truncated retry is surfaced on stderr.
 *
 * Uses the gateway chat-transport test seam — no API key, no network.
 */
import { afterAll, describe, test, expect, beforeEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import {
  extractFactsFromTurn,
  getFactsExtractionMaxTokens,
  DEFAULT_EXTRACTION_MAX_TOKENS,
} from '../src/core/facts/extract.ts';
import type { BrainEngine } from '../src/core/engine.ts';

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
});

// Shard hygiene (same rationale as facts-extract-silent-no-op.test.ts):
// restore the legacy 1536-d embedding pin so later fresh-schema files in
// this shard don't inherit a dimensionless gateway.
afterAll(() => {
  __setChatTransportForTests(null);
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

function chatResult(text: string, stopReason: ChatResult['stopReason']): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6',
    providerId: 'anthropic',
  } as ChatResult;
}

const GOOD_JSON = '{"facts":[{"fact":"user gave up alcohol","kind":"commitment",' +
  '"entity":null,"confidence":1.0,"notability":"high",' +
  '"metric":null,"value":null,"unit":null,"period":null}]}';

describe('getFactsExtractionMaxTokens (#2113)', () => {
  test('defaults to 4000 without an engine', async () => {
    expect(await getFactsExtractionMaxTokens()).toBe(DEFAULT_EXTRACTION_MAX_TOKENS);
    expect(DEFAULT_EXTRACTION_MAX_TOKENS).toBe(4000);
  });

  test('reads facts.extraction_max_tokens from the engine', async () => {
    const engine = { getConfig: async () => '9000' } as unknown as BrainEngine;
    expect(await getFactsExtractionMaxTokens(engine)).toBe(9000);
  });

  test('invalid config values fall back to the default', async () => {
    for (const bad of ['garbage', '0', '-5', '']) {
      const engine = { getConfig: async () => bad } as unknown as BrainEngine;
      expect(await getFactsExtractionMaxTokens(engine)).toBe(DEFAULT_EXTRACTION_MAX_TOKENS);
    }
  });
});

describe('extractFactsFromTurn truncation handling (#2113)', () => {
  test('default call carries maxTokens=4000 (was hardcoded 1500)', async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return chatResult(GOOD_JSON, 'end');
    });
    const facts = await extractFactsFromTurn({
      turnText: 'I gave up alcohol.',
      source: 'test:truncation',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.maxTokens).toBe(4000);
    expect(facts).toHaveLength(1);
  });

  test("stopReason 'length' retries ONCE at double the cap and recovers the facts", async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      // First call: truncated garbage. Retry: full JSON.
      return seen.length === 1
        ? chatResult('{"facts":[{"fact":"user gave up alco', 'length')
        : chatResult(GOOD_JSON, 'end');
    });
    const facts = await extractFactsFromTurn({
      turnText: 'I gave up alcohol.',
      source: 'test:truncation',
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.maxTokens).toBe(seen[0]!.maxTokens! * 2);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.fact).toContain('alcohol');
  });

  test('still-truncated retry does not retry again (bounded at one retry)', async () => {
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      return chatResult('{"facts":[{"fac', 'length');
    });
    const facts = await extractFactsFromTurn({
      turnText: 'I gave up alcohol.',
      source: 'test:truncation',
    });
    expect(calls).toBe(2);
    expect(facts).toEqual([]);
  });
});
