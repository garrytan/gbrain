/**
 * #6260: synthesize_concepts reads the narrative's stop reason. A narrative
 * stopped by the output cap, a refusal or a content filter never replaces an
 * existing narrative and never advances the member hash; a new concept gets
 * the template fallback and is retried. Failures on unchanged members are
 * bounded: after MAX_CONCEPT_ATTEMPTS the concept is skipped before any spend
 * until its members change.
 *
 * Hermetic: PGLite + injected `_atoms` and `_chat`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { MAX_CONCEPT_ATTEMPTS } from '../../src/core/cycle/concept-retry-bound.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
}, 60000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
});

const atoms = (n = 5, extra = '') => Array.from({ length: n }, (_, i) => ({
  slug: `atoms/a${i}`, concept_refs: ['concepts/x'], body: `body ${i}${extra}`, title: `A${i}`,
}));

function chatWith(text: string, stopReason: ChatResult['stopReason'], counter: { calls: number }) {
  return async (): Promise<ChatResult> => {
    counter.calls++;
    return { text, blocks: [{ type: 'text', text }], stopReason,
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' };
  };
}

async function concept() {
  const page = await engine.getPage('concepts/x', { sourceId: 'default' });
  return page && { body: page.compiled_truth, mode: page.frontmatter.synthesis_mode, hash: page.frontmatter.member_hash };
}

describe('synthesize_concepts stop reasons (#6260)', () => {
  test('an existing llm narrative survives a clipped answer with its body and member hash', async () => {
    const counter = { calls: 0 };
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms(), _chat: chatWith('A complete narrative about x.', 'end', counter) });
    const before = await concept();
    expect(before?.mode).toBe('llm');
    const changed = atoms(5, ' changed');
    const r = await runPhaseSynthesizeConcepts(engine, { _atoms: changed, _chat: chatWith('A clipped narr', 'length', counter) });
    expect(JSON.stringify(r.details.failures)).toContain('stopReason=length');
    const after = await concept();
    expect(after?.body).toBe(before?.body);
    expect(after?.hash).toBe(before?.hash);
  });

  for (const stop of ['length', 'refusal', 'content_filter'] as const) {
    test(`${stop}: a new concept gets the template fallback, and an end answer later writes the narrative`, async () => {
      const counter = { calls: 0 };
      await runPhaseSynthesizeConcepts(engine, { _atoms: atoms(), _chat: chatWith('Partial', stop, counter) });
      expect((await concept())?.mode).toBe('error_fallback');
      await runPhaseSynthesizeConcepts(engine, { _atoms: atoms(), _chat: chatWith('A complete narrative about x.', 'end', counter) });
      const page = await concept();
      expect(page?.mode).toBe('llm');
      expect(page?.body).toContain('A complete narrative about x.');
    });
  }

  test(`repeated clipped answers on unchanged members stop calling the model after ${MAX_CONCEPT_ATTEMPTS} attempts`, async () => {
    const counter = { calls: 0 };
    const chat = chatWith('Partial', 'length', counter);
    for (let i = 0; i < MAX_CONCEPT_ATTEMPTS + 2; i++) await runPhaseSynthesizeConcepts(engine, { _atoms: atoms(), _chat: chat });
    expect(counter.calls).toBe(MAX_CONCEPT_ATTEMPTS);
    const skipped = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms(), _chat: chat });
    expect(skipped.details.skipped_retry_bound).toEqual(['concepts/x']);
    expect(counter.calls).toBe(MAX_CONCEPT_ATTEMPTS);
    // Changed members re-arm the concept.
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms(5, ' new'), _chat: chat });
    expect(counter.calls).toBe(MAX_CONCEPT_ATTEMPTS + 1);
  });
});
