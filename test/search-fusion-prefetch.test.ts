/**
 * #6721: fusion's three reads about its candidate rows cost one round trip of
 * wall time, not three.
 *
 * 1. Protects: `prefetchFusionReads` (search/hybrid/fusion-prefetch.ts) starts
 *    the unverified-extraction marks, the cosine re-score's chunk embeddings
 *    and the generated-page rows together, before any of them answers; and a
 *    generated-page read made for a superset of the pool demotes exactly what
 *    the pool's own read did.
 * 2. Fails when: `prefetchFusionReads` waits on one read before starting the
 *    next, drops a read, or the prefetched generated rows leak a page outside
 *    the pool into demotion.
 * 3. Existing coverage: test/search-fusion-prefetch-wiring.test.ts pins that
 *    `fuseArms` uses it; test/search-provenance-demotion.test.ts pins what
 *    demotion does; test/cosine-rescore-*.test.ts pin the re-score.
 * 4. Seam: a recording engine whose reads finish only when the test releases
 *    them; the PGLite mention brain for the demotion parity check.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { SearchResult } from '../src/core/types.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { prefetchFusionReads } from '../src/core/search/hybrid/fusion-prefetch.ts';
import { applyGeneratedDemotion, readGeneratedPages } from '../src/core/search/provenance-demotion.ts';
import { mentionBrain, resetMentionBrain, sweep } from './helpers/mention-brain.ts';

const row = (page_id: number, chunk_id: number) => ({ slug: `p/${page_id}`, page_id, chunk_id, source_id: 'default', score: 1 }) as SearchResult;

function gatedEngine(fail?: string) {
  const started: string[] = [];
  const gates: Array<() => void> = [];
  const gate = <T>(label: string, value: T) => new Promise<T>((resolve, reject) => {
    started.push(label);
    gates.push(() => (label === fail ? reject(new Error(`${label} failed`)) : resolve(value)));
  });
  const engine = {
    getUnverifiedExtractionPageIds: (ids: number[]) => gate('marks', new Map(ids.map(id => [id, { unverified: false, status: 'draft' }]))),
    getEmbeddingsByChunkIds: (ids: number[]) => gate('embeddings', new Map(ids.map(id => [id, new Float32Array([1, 0])]))),
    executeRaw: (sql: string) => gate(sql.includes('dream_generated') ? 'generated' : `other: ${sql.slice(0, 30)}`, []),
  } as unknown as BrainEngine;
  return { engine, started, release: () => { for (const open of gates.splice(0)) open(); } };
}

describe('prefetchFusionReads', () => {
  test('the marks, embeddings and generated-page reads are all issued before any of them answers', async () => {
    const { engine, started, release } = gatedEngine();
    const prefetch = prefetchFusionReads(engine, [row(1, 10), row(2, 20), row(1, 11)], undefined, 'embedding');
    await Promise.resolve();
    expect([...started].sort()).toEqual(['embeddings', 'generated', 'marks']);
    release();
    expect([...(await prefetch.marks!).keys()]).toEqual([1, 2]);
    expect([...(await prefetch.embeddings!).keys()]).toEqual([10, 20, 11]);
    expect(await prefetch.generated!).toEqual([]);
  });

  test('no embeddings read when the re-score will not hydrate one column; no reads for an empty pool', async () => {
    const { engine, started, release } = gatedEngine();
    const prefetch = prefetchFusionReads(engine, [row(1, 10)], undefined, null);
    await Promise.resolve();
    expect(prefetch.embeddings).toBeUndefined();
    expect([...started].sort()).toEqual(['generated', 'marks']);
    release();
    expect(prefetchFusionReads(engine, [], undefined, 'embedding')).toEqual({});
  });

  test('a failed read rejects for its consumer and is never reported unhandled', async () => {
    const { engine, release } = gatedEngine('embeddings');
    const prefetch = prefetchFusionReads(engine, [row(1, 10)], undefined, 'embedding');
    release();
    await expect(prefetch.embeddings!).rejects.toThrow('embeddings failed');
    expect(await prefetch.marks!).toBeInstanceOf(Map);
  });
});

describe('generated-page demotion with prefetched rows', () => {
  let brain: PGLiteEngine;
  beforeAll(async () => { brain = await mentionBrain(); }, 120_000);
  afterAll(async () => { await brain.disconnect(); });
  beforeEach(async () => { await resetMentionBrain(brain); });

  async function put(slug: string, type: string, title: string, body: string, fm: Record<string, unknown> = {}) {
    await importFromContent(brain, slug, serializeMarkdown(fm, body, '', { type, title, tags: [] }), { noEmbed: true, forceRechunk: true });
  }
  async function rows(slugs: string[]): Promise<SearchResult[]> {
    const r = await brain.executeRaw<{ id: number; slug: string; source_id: string }>('SELECT id, slug, source_id FROM pages WHERE slug = ANY($1::text[])', [slugs]);
    return slugs.map(s => { const p = r.find(x => x.slug === s)!; return { slug: s, page_id: Number(p.id), source_id: p.source_id, score: 1, title: s, type: 'note', chunk_text: '', chunk_source: 'compiled_truth', chunk_id: 0, chunk_index: 0, stale: false } as SearchResult; });
  }

  test('rows read for a superset of the pool demote exactly what the pool read demotes', async () => {
    await put('crm/widget-co', 'crm', 'CRM record: Widget Co', 'Account code: WGCO. Discount: 12 percent.');
    await put('syntheses/widget', 'synthesis', 'Summary: Widget Co', 'Widget Co discount is 10 percent (summary).', { dream_generated: true });
    await put('syntheses/other', 'synthesis', 'Summary: Widget Co history', 'Widget Co discount history (summary).', { dream_generated: true });
    await sweep(brain);
    const scope = { sourceId: 'default', excludePrivate: false };
    const own = await rows(['syntheses/widget', 'crm/widget-co']);
    await applyGeneratedDemotion(brain, own, 'Widget Co discount', scope);
    const viaPrefetch = await rows(['syntheses/widget', 'crm/widget-co']);
    const superset = await rows(['syntheses/widget', 'crm/widget-co', 'syntheses/other']);
    const prefetched = readGeneratedPages(brain, superset.map(r => r.page_id));
    await applyGeneratedDemotion(brain, viaPrefetch, 'Widget Co discount', scope, prefetched);
    expect(viaPrefetch).toEqual(own);
    expect(own.find(r => r.slug === 'syntheses/widget')).toMatchObject({ provenance: 'generated', generated_demotion: 0.5 });
  });
});
