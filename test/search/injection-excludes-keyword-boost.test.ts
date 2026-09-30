/**
 * Read-path audit leftovers:
 *  - the alias hop and the exact-lookup tier inject pages AFTER the engine
 *    arms, so they must honor the same prefix excludes the arms apply in SQL
 *    (caller exclude_slug_prefixes plus the default/env hard excludes), on
 *    every return path;
 *  - the keyword-only (no embedding provider) path never applied the intent
 *    exact-match boost.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { installPageProjection, readProjectionSnapshot } from '../../src/core/page-state/projections.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import type { HybridSearchMeta } from '../../src/core/types.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

async function seed(slug: string, type: string, title: string, text: string, dim: number) {
  await engine.putPage(slug, { type, title, compiled_truth: text } as any);
  const snap = (await readProjectionSnapshot(engine, slug, 'default', { allowUnsealed: true }))!;
  await installPageProjection(engine, snap, [{
    chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', embedding: basisEmbedding(dim, 1536), token_count: 5,
  }] as any, { seal: true });
}

const noRerank = { reranker: { enabled: false, topNIn: 0, topNOut: null } as any };
const vec = { ...noRerank, queryEmbedFn: () => basisEmbedding(3, 1536) };

describe('identity injections honor prefix excludes', () => {
  test('alias hop never injects a page under a caller exclude_slug_prefix', async () => {
    await seed('notes/a', 'note', 'Note A', 'widget alpha', 3);
    await seed('private-drafts/hall', 'note', 'Hall Draft', 'unrelated text entirely', 9);
    await engine.setPageAliases('private-drafts/hall', 'default', ['hall of light']);
    const out = await hybridSearch(engine, 'hall of light', { ...vec, exclude_slug_prefixes: ['private-drafts/'] });
    expect(out.map(r => r.slug)).not.toContain('private-drafts/hall');
  }, 60_000);

  test('exact-lookup slug probe never injects a hard-excluded or prefix-excluded page', async () => {
    await seed('notes/a', 'note', 'Note A', 'widget alpha', 3);
    await seed('test/fixture-page', 'note', 'Fixture', 'fixture body', 9);
    await seed('private-drafts/plan', 'note', 'Plan', 'plan body', 9);
    const hard = await hybridSearch(engine, 'test/fixture-page', vec);
    expect(hard.map(r => r.slug)).not.toContain('test/fixture-page');
    const admitted = await hybridSearch(engine, 'test/fixture-page', { ...vec, include_slug_prefixes: ['test/'] });
    expect(admitted.map(r => r.slug)).toContain('test/fixture-page');
    const prefixed = await hybridSearch(engine, 'private-drafts/plan', { ...vec, exclude_slug_prefixes: ['private-drafts/'] });
    expect(prefixed.map(r => r.slug)).not.toContain('private-drafts/plan');
  }, 60_000);

  test('keyword-only path: alias hop honors exclude_slugs and prefix excludes', async () => {
    await seed('notes/a', 'note', 'Note A', 'widget alpha', 3);
    await seed('projects/hall', 'note', 'Hall', 'unrelated text entirely', 9);
    await engine.setPageAliases('projects/hall', 'default', ['hall of light']);
    let meta: HybridSearchMeta | undefined;
    const bySlug = await hybridSearch(engine, 'hall of light', { ...noRerank, exclude_slugs: ['projects/hall'], onMeta: (m) => { meta = m; } });
    expect(meta?.vector_enabled).toBe(false);
    expect(bySlug.map(r => r.slug)).not.toContain('projects/hall');
    const byPrefix = await hybridSearch(engine, 'hall of light', { ...noRerank, exclude_slug_prefixes: ['projects/'] });
    expect(byPrefix.map(r => r.slug)).not.toContain('projects/hall');
  }, 60_000);
});

describe('keyword-only path applies the intent exact-match boost', () => {
  test('"who is Alice Example" boosts the Alice Example page without an embedding provider', async () => {
    await seed('people/alice-example', 'person', 'Alice Example', 'Alice Example runs the widget lab.', 5);
    await seed('people/charlie-example', 'person', 'Charlie Example', 'Charlie Example and Alice Example run the widget lab together.', 6);
    let meta: HybridSearchMeta | undefined;
    const out = await hybridSearch(engine, 'who is Alice Example', { ...noRerank, onMeta: (m) => { meta = m; } });
    expect(meta?.vector_enabled).toBe(false);
    const alice = out.find(r => r.slug === 'people/alice-example');
    expect(alice?.exact_match_boost).toBe(1.25);
    expect(out[0].slug).toBe('people/alice-example');
  }, 60_000);
});
