// synthesize_concepts concept identity and narrative stability.
//
// C-4: spelling variants of one concept ("Network Effects", "network-effects",
// "concepts/network-effects") are one concept page with a valid slug.
// C-5: an unchanged member set costs nothing on the next cycle, and a page that
// already has an LLM narrative is never replaced by a template stub when the
// budget runs out or the model errors.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { validatePageSlug } from '../../src/core/ops/context.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 240000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
}, 120000);

function chatReturning(text: string, calls: { n: number }): (o: ChatOpts) => Promise<ChatResult> {
  return async (o: ChatOpts) => {
    calls.n++;
    return {
      text,
      blocks: [{ type: 'text', text }],
      stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: o.model ?? 'unset',
      providerId: 'test',
    };
  };
}

async function conceptPages(): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE type = 'concept' AND deleted_at IS NULL ORDER BY slug`,
  );
  return rows.map(r => r.slug);
}

const t2Atoms = (n = 5) => Array.from({ length: n }, (_, i) => ({
  slug: `atoms/a${i}`, title: `A${i}`, body: `body ${i}`, concept_refs: ['flywheel'],
}));

describe('synthesize_concepts concept identity (C-4)', () => {
  test('spelling variants merge into one concept page with a valid slug', async () => {
    const atoms = [
      { slug: 'atoms/v1', title: 'V1', body: 'b1', concept_refs: ['Network Effects'] },
      { slug: 'atoms/v2', title: 'V2', body: 'b2', concept_refs: ['network-effects'] },
      { slug: 'atoms/v3', title: 'V3', body: 'b3', concept_refs: ['concepts/network-effects'] },
      { slug: 'atoms/v4', title: 'V4', body: 'b4', concept_refs: ['Network  effects ', 'network effects'] },
    ];
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'default' });
    const slugs = await conceptPages();
    expect(slugs).toEqual(['concepts/network-effects']);
    for (const slug of slugs) expect(() => validatePageSlug(slug)).not.toThrow();
    const page = await engine.getPage('concepts/network-effects', { sourceId: 'default' });
    // One atom naming the concept twice still counts once.
    expect(page?.frontmatter.mention_count).toBe(4);
    expect((result.details as Record<string, unknown>).groups_found).toBe(1);
  }, 120000);

  test('a concept ref that normalizes to nothing is dropped instead of written', async () => {
    const atoms = [
      { slug: 'atoms/x1', title: 'X1', body: 'b1', concept_refs: ['!!!', 'theme'] },
      { slug: 'atoms/x2', title: 'X2', body: 'b2', concept_refs: ['!!!', 'theme'] },
    ];
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'default' });
    expect(await conceptPages()).toEqual(['concepts/theme']);
  }, 120000);
});

describe('synthesize_concepts narrative stability (C-5)', () => {
  test('an unchanged member set is not re-synthesized or rewritten', async () => {
    const calls = { n: 0 };
    await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(), sourceId: 'default', _chat: chatReturning('Good narrative.', calls) });
    expect(calls.n).toBe(1);
    const before = await engine.getPage('concepts/flywheel', { sourceId: 'default' });

    const second = await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(), sourceId: 'default', _chat: chatReturning('Other.', calls) });
    expect(calls.n).toBe(1);
    const after = await engine.getPage('concepts/flywheel', { sourceId: 'default' });
    expect(after?.compiled_truth.trim()).toBe('Good narrative.');
    expect(after?.frontmatter.synthesized_at).toBe(before?.frontmatter.synthesized_at);
    expect((second.details as Record<string, unknown>).skipped_unchanged).toEqual(['concepts/flywheel']);
  }, 120000);

  test('a model error never downgrades an LLM narrative to a template stub', async () => {
    const calls = { n: 0 };
    await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(5), sourceId: 'default', _chat: chatReturning('Good narrative.', calls) });
    const failing = (async () => { throw new Error('boom: unexpected provider fault'); }) as unknown as (o: ChatOpts) => Promise<ChatResult>;
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(6), sourceId: 'default', _chat: failing });
    const page = await engine.getPage('concepts/flywheel', { sourceId: 'default' });
    expect(page?.compiled_truth.trim()).toBe('Good narrative.');
    expect(page?.frontmatter.synthesis_mode).toBe('llm');
    expect((result.details as Record<string, unknown>).kept_existing_narrative).toEqual(['concepts/flywheel']);
  }, 120000);

  test('an empty model answer keeps the existing LLM narrative too', async () => {
    const calls = { n: 0 };
    await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(5), sourceId: 'default', _chat: chatReturning('Good narrative.', calls) });
    await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(7), sourceId: 'default', _chat: chatReturning('   ', calls) });
    const page = await engine.getPage('concepts/flywheel', { sourceId: 'default' });
    expect(page?.compiled_truth.trim()).toBe('Good narrative.');
    expect(page?.frontmatter.synthesis_mode).toBe('llm');
  }, 120000);

  test('a fallback page is retried with the LLM on the next cycle', async () => {
    const failing = (async () => { throw new Error('boom: unexpected provider fault'); }) as unknown as (o: ChatOpts) => Promise<ChatResult>;
    await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(), sourceId: 'default', _chat: failing });
    expect((await engine.getPage('concepts/flywheel', { sourceId: 'default' }))?.frontmatter.synthesis_mode).toBe('error_fallback');
    const calls = { n: 0 };
    await runPhaseSynthesizeConcepts(engine, { _atoms: t2Atoms(), sourceId: 'default', _chat: chatReturning('Recovered.', calls) });
    expect(calls.n).toBe(1);
    const page = await engine.getPage('concepts/flywheel', { sourceId: 'default' });
    expect(page?.compiled_truth.trim()).toBe('Recovered.');
    expect(page?.frontmatter.synthesis_mode).toBe('llm');
  }, 120000);
});
