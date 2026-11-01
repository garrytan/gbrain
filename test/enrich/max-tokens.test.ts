/**
 * enrich's write-up output cap leaves room for a thinking-by-default model's reasoning. Claude 5 thinks by default and
 * its reasoning counts against maxTokens, so the old fixed 2048 cut write-ups off: on a production brain, after its
 * reasoning tier moved to Claude Sonnet 5.5, 123 of 1,097 enrich-phase calls ended at exactly 2048 output tokens.
 * Pure (no engine, no provider) — runs in the fast parallel loop.
 */
import { describe, test, expect } from 'bun:test';
import { enrichMaxTokens, ENRICH_MAX_TOKENS } from '../../src/commands/enrich.ts';
import { THINKING_MODEL_MAX_OUTPUT_TOKENS, defaultMaxOutputTokens } from '../../src/core/ai/gateway.ts';

describe('enrichMaxTokens', () => {
  test('a Claude 5 model gets the gateway thinking-model cap', () => {
    for (const m of ['anthropic:claude-sonnet-5-5', 'anthropic:claude-opus-5-5', 'anthropic:claude-haiku-5-5', 'anthropic:claude-sonnet-5']) {
      expect(enrichMaxTokens(m)).toBe(THINKING_MODEL_MAX_OUTPUT_TOKENS);
      expect(enrichMaxTokens(m)).toBe(defaultMaxOutputTokens(m));      // what chat() would use with no explicit cap
    }
  });

  test('the cap leaves a write-up room beyond the old 2048 on a thinking model', () => {
    expect(THINKING_MODEL_MAX_OUTPUT_TOKENS).toBeGreaterThan(ENRICH_MAX_TOKENS);
  });

  test('a non-thinking model keeps the 2048 write-up cap', () => {
    expect(ENRICH_MAX_TOKENS).toBe(2048);
    expect(enrichMaxTokens('not-a-provider:plain-model')).toBe(2048);  // unknown providers count as non-thinking
  });

  test('the default synthesis passes the per-model cap to chat()', async () => {
    const src = await Bun.file(new URL('../../src/commands/enrich.ts', import.meta.url)).text();
    const body = src.slice(src.indexOf('const defaultSynthesize'), src.indexOf('const defaultSynthesize') + 400);
    expect(body).toContain('maxTokens: enrichMaxTokens(model)');
    expect(body).not.toContain('maxTokens: 2048');
  });
});
