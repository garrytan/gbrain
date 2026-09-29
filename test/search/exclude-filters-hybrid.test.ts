/**
 * Read-path audit #8: hybridSearch rebuilt its engine opts and dropped
 * exclude_slugs / exclude_slug_prefixes / include_slug_prefixes, and PGLite's
 * searchKeyword ignored exclude_slugs and type (Postgres honors both).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { installPageProjection, readProjectionSnapshot } from '../../src/core/page-state/projections.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

async function seed(slug: string, type: string, text: string, dim: number) {
  await engine.putPage(slug, { type, title: slug, compiled_truth: text } as any);
  const snap = (await readProjectionSnapshot(engine, slug, 'default', { allowUnsealed: true }))!;
  await installPageProjection(engine, snap, [{
    chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', embedding: basisEmbedding(dim, 1536), token_count: 5,
  }] as any, { seal: true });
}

const rr = { reranker: { enabled: false, topNIn: 0, topNOut: null } as any, queryEmbedFn: () => basisEmbedding(3, 1536) };

describe('exclusion filters', () => {
  test('PGLite searchKeyword honors exclude_slugs and type', async () => {
    await seed('notes/a', 'note', 'widget alpha', 3);
    await seed('people/b', 'person', 'widget beta', 3);
    expect((await engine.searchKeyword('widget', { exclude_slugs: ['notes/a'] })).map(r => r.slug)).toEqual(['people/b']);
    expect((await engine.searchKeyword('widget', { type: 'person' as any })).map(r => r.slug)).toEqual(['people/b']);
  }, 60_000);

  test('hybridSearch passes exclude_slugs and exclude_slug_prefixes to every arm', async () => {
    await seed('notes/a', 'note', 'widget alpha', 3);
    await seed('private-drafts/b', 'note', 'widget beta', 3);
    await seed('notes/c', 'note', 'widget gamma', 3);
    const out = await hybridSearch(engine, 'widget', { ...rr, exclude_slugs: ['notes/a'], exclude_slug_prefixes: ['private-drafts/'] });
    expect(out.map(r => r.slug)).toEqual(['notes/c']);
  }, 60_000);

  test('include_slug_prefixes re-admits a hard-excluded prefix through hybridSearch', async () => {
    await seed('test/fixture-page', 'note', 'widget delta', 3);
    const plain = await hybridSearch(engine, 'widget', rr);
    const admitted = await hybridSearch(engine, 'widget', { ...rr, include_slug_prefixes: ['test/'] });
    expect(plain.map(r => r.slug)).not.toContain('test/fixture-page');
    expect(admitted.map(r => r.slug)).toContain('test/fixture-page');
  }, 60_000);

  test('the alias hop never injects an excluded slug', async () => {
    await seed('notes/a', 'note', 'widget alpha', 3);
    await seed('projects/hall', 'note', 'unrelated text entirely', 9);
    await engine.setPageAliases('projects/hall', 'default', ['hall of light']);
    const out = await hybridSearch(engine, 'hall of light', { ...rr, exclude_slugs: ['projects/hall'] });
    expect(out.map(r => r.slug)).not.toContain('projects/hall');
  }, 60_000);
});
