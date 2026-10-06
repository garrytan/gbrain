// A-N2 / #5166: synthesize_concepts metered its narrative calls through
// `canonicalLookup` alone, so a claude-cli model (priced through its Anthropic
// sibling everywhere else) and an operator's `pricing.overrides` row were both
// ignored, and an unpriced model fell back to Sonnet rates without a word. The
// phase now prices through the shared `priceFor` and names the fallback.
//
// Hermetic: PGLite + injected `_atoms` and `_chat`. No provider credentials and
// no network.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

const t2Atoms = () =>
  Array.from({ length: 5 }, (_, i) => ({
    slug: `atoms/a${i}`,
    concept_refs: ['concepts/x'],
    body: `body ${i}`,
    title: `A${i}`,
  }));

/** Answers as `served`, reporting 1M input tokens and no output, so spend == the input rate. */
function chatAs(served: string): (o: ChatOpts) => Promise<ChatResult> {
  return async () => ({
    text: 'narrative text',
    blocks: [{ type: 'text', text: 'narrative text' }],
    stopReason: 'end',
    usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: served,
    providerId: served.split(':')[0]!,
  });
}

describe('synthesize_concepts prices through the shared resolver', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60000);

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
  });

  test('a claude-cli model is metered at its Anthropic sibling rate, not the Sonnet fallback', async () => {
    const r = await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(), _chat: chatAs('claude-cli:claude-opus-5-5') });
    expect(r.details.estimated_spend_usd).toBeCloseTo(4, 6);
    expect(r.details.pricing_fallback_models).toEqual([]);
  });

  test('an operator pricing.overrides row wins', async () => {
    await engine.setConfig('pricing.overrides', JSON.stringify({ 'claude-cli:claude-opus-5-5': { input: 1, output: 1 } }));
    const r = await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(), _chat: chatAs('claude-cli:claude-opus-5-5') });
    expect(r.details.estimated_spend_usd).toBeCloseTo(1, 6);
  });

  test('a claude-cli:* wildcard prices every claude-cli model', async () => {
    await engine.setConfig('pricing.overrides', JSON.stringify({ 'claude-cli:*': 0 }));
    const r = await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(), _chat: chatAs('claude-cli:claude-opus-5-5') });
    expect(r.details.estimated_spend_usd).toBe(0);
  });

  test('deepseek:deepseek-flash is priced at the peak row (#5847)', async () => {
    const r = await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(), _chat: chatAs('deepseek:deepseek-flash') });
    expect(r.details.estimated_spend_usd).toBeCloseTo(0.3, 6);
    expect(r.details.pricing_fallback_models).toEqual([]);
  });

  test('an unpriced model is metered at the Sonnet fallback and named in the phase details', async () => {
    const r = await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(), _chat: chatAs('litellm:house-model') });
    expect(r.details.estimated_spend_usd).toBeCloseTo(3, 6);
    expect(r.details.pricing_fallback_models).toEqual(['litellm:house-model']);
  });
});
