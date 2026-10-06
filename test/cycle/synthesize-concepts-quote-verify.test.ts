// synthesize_concepts grounds the narrative's quotes against exactly the atom
// titles and bodies its prompt carried, before the concept page is written: a
// claim with a quote no atom contains leaves the narrative for frontmatter
// unverified_claims; supported quotes and computed counts stay. Opt-in:
// dream.quote_verify (default on).
//
// Hermetic: PGLite + injected `_atoms` and `_chat`.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

const atoms = () => Array.from({ length: 5 }, (_, i) => ({
  slug: `atoms/a${i}`,
  concept_refs: ['concepts/compounding'],
  body: i === 0 ? 'Patience lets small advantages "compound into durable moats" over years.' : `Atom ${i} about compounding effort.`,
  title: `Compounding ${i}`,
}));

function chat(text: string): (o: ChatOpts) => Promise<ChatResult> {
  return async (o: ChatOpts) => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: o.model ?? 'unset', providerId: 'test' });
}

const NARRATIVE = 'Five atoms agree that small advantages "compound into durable moats" over time.\n\nOne atom claims "luck beats skill every time".';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
  await engine.setConfig('dream.quote_verify', 'true');
});

describe('synthesize_concepts quote grounding', () => {
  test('an unsupported quote leaves the narrative for unverified_claims before the page is written', async () => {
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms(), _chat: chat(NARRATIVE) });
    const page = await engine.getPage('concepts/compounding');
    expect(page).toBeTruthy();
    expect(page!.compiled_truth).toContain('compound into durable moats');
    expect(page!.compiled_truth).toContain('Five atoms');
    expect(page!.compiled_truth).not.toContain('luck beats skill');
    const claims = page!.frontmatter.unverified_claims as Array<{ text: string; reason: string }>;
    expect(claims).toHaveLength(1);
    expect(claims[0]!.reason).toBe('quote_not_in_source');
  });

  test('on by default; false turns it off, and the synthesis switch does not turn it back on', async () => {
    await engine.unsetConfig('dream.quote_verify');
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms(), _chat: chat(NARRATIVE) });
    expect((await engine.getPage('concepts/compounding'))!.compiled_truth).not.toContain('luck beats skill');
    await resetPgliteState(engine);
    await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
    await engine.setConfig('dream.quote_verify', 'false');
    await engine.setConfig('dream.synthesize.quote_verify', 'true');
    try {
      await runPhaseSynthesizeConcepts(engine, { _atoms: atoms(), _chat: chat(NARRATIVE) });
      const page = await engine.getPage('concepts/compounding');
      expect(page!.compiled_truth).toContain('luck beats skill');
      expect(page!.frontmatter.unverified_claims).toBeUndefined();
    } finally {
      await engine.setConfig('dream.quote_verify', 'true');
    }
  });
});
