/**
 * RRF fuses at PAGE grain. Every arm is page-grain (best chunk per page) but
 * picks its own representative chunk, so chunk-keyed fusion split one page's
 * cross-arm agreement across several entries. These tests pin that a page's
 * votes sum across arms whatever chunk each arm picked, that one list votes
 * for a page once (its best rank), that only the page's lead chunk carries the
 * page vote (so a second chunk cannot crowd another page out of a
 * chunk-limited result), and the end-to-end probe from the read-path audit: a
 * page ranked #1 by keyword AND vector must beat a page ranked #2 by both.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { installPageProjection, readProjectionSnapshot } from '../../src/core/page-state/projections.ts';
import { hybridSearch, rrfFusion, rrfFusionWeighted } from '../../src/core/search/hybrid.ts';
import type { SearchResult } from '../../src/core/types.ts';

function row(slug: string, chunk_id: number, over: Partial<SearchResult> = {}): SearchResult {
  return {
    slug, page_id: 1, title: slug, type: 'note', chunk_text: `${slug} chunk ${chunk_id}`,
    chunk_source: 'compiled_truth', chunk_id, chunk_index: chunk_id, score: 0.5, stale: false, ...over,
  } as SearchResult;
}

describe('rrf page-grain fusion (pure)', () => {
  test('a page #1 in both arms via DIFFERENT chunks beats a page #2 in both', () => {
    const vector = [row('a', 2), row('b', 10), row('f0', 20), row('f1', 21)];
    const keyword = [row('a', 1), row('b', 10)];
    const out = rrfFusionWeighted([{ list: vector, k: 60 }, { list: keyword, k: 60 }], false);
    // The page's lead (tie on own vote -> first list, the vector arm's chunk)
    // carries the summed page vote; its other chunk keeps its own vote.
    expect(out.map(r => `${r.slug}#${r.chunk_id}`)).toEqual(['a#2', 'b#10', 'a#1', 'f0#20', 'f1#21']);
    expect(out[0].score).toBe(1);
    expect(out[1].score).toBeCloseTo((2 / 61) / (2 / 60), 12);
    expect(out[2].score).toBeCloseTo((1 / 60) / (2 / 60), 12);
  });

  test('a page\'s second chunk never crowds out another page\'s lead', () => {
    const vector = [row('a', 1), row('b', 10), row('c', 20)];
    const keyword = [row('a', 2), row('b', 10), row('c', 20)];
    const out = rrfFusionWeighted([{ list: vector, k: 60 }, { list: keyword, k: 60 }], false);
    expect(out.slice(0, 3).map(r => r.slug)).toEqual(['a', 'b', 'c']);
    expect(out[3].slug).toBe('a');
  });

  test('unweighted rrfFusion sums per page too', () => {
    const out = rrfFusion([[row('a', 2), row('b', 10)], [row('a', 1), row('b', 10)]], 60, false);
    expect(out.map(r => `${r.slug}#${r.chunk_id}`)).toEqual(['a#2', 'b#10', 'a#1']);
  });

  test('one list votes for a page once, at its best rank', () => {
    const single = [row('a', 1), row('a', 2), row('b', 10)];
    const other = [row('b', 10)];
    const out = rrfFusionWeighted([{ list: single, k: 60 }, { list: other, k: 60 }], false);
    // a: 1/60 (its second chunk adds no second vote); b: 1/62 + 1/60.
    expect(out[0].slug).toBe('b');
    const a = out.filter(r => r.slug === 'a');
    expect(a.length).toBe(2);
    expect(a[0].chunk_id).toBe(1);
    expect(a[0].score).toBeCloseTo((1 / 60) / (1 / 62 + 1 / 60), 12);
  });

  test('same slug in different sources stays two pages', () => {
    const out = rrfFusionWeighted([
      { list: [row('a', 1, { source_id: 's1' }), row('a', 2, { source_id: 's2' })], k: 60 },
      { list: [row('a', 3, { source_id: 's1' })], k: 60 },
    ], false);
    expect(out[0].source_id).toBe('s1');
    expect(out.find(r => r.source_id === 's2')!.score).toBeLessThan(out[0].score);
  });

  test('weights scale the page vote; keyword_hit stays per chunk', () => {
    const out = rrfFusionWeighted([
      { list: [row('a', 1, { keyword_hit: true })], k: 60 },
      { list: [row('a', 2), row('b', 5)], k: 60, weight: 0.5 },
    ], false);
    expect(out.map(r => r.slug)).toEqual(['a', 'a', 'b']);
    expect(out.find(r => r.chunk_id === 1)!.keyword_hit).toBe(true);
    expect(out.find(r => r.chunk_id === 2)!.keyword_hit).toBeUndefined();
  });
});

describe('rrf page-grain fusion (PGLite probe)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  const vec = (pairs: Array<[number, number]>) => {
    const v = new Float32Array(1536);
    for (const [i, x] of pairs) v[i] = x;
    const n = Math.hypot(...v);
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
  };
  async function seed(slug: string, title: string, chunks: Array<{ text: string; emb: Float32Array }>) {
    await engine.putPage(slug, { type: 'note', title, compiled_truth: chunks.map(c => c.text).join('\n\n') } as any);
    const snap = (await readProjectionSnapshot(engine, slug, 'default', { allowUnsealed: true }))!;
    await installPageProjection(engine, snap, chunks.map((c, i) => ({
      chunk_index: i, chunk_text: c.text, chunk_source: 'compiled_truth', embedding: c.emb, token_count: 10,
    })) as any, { seal: true });
  }

  test('page #1 in BOTH keyword and vector arms (different chunks) ranks first', async () => {
    await seed('notes/page-a', 'Alpha', [
      { text: 'Introductory remarks about the project.', emb: vec([[50, 1]]) },
      { text: 'zebra migration zebra migration zebra migration observed', emb: vec([[60, 1]]) },
      { text: 'Savanna herds move seasonally across the plains.', emb: vec([[7, 1]]) },
    ]);
    await seed('notes/page-b', 'Beta', [{ text: 'zebra migration notes', emb: vec([[7, 1], [8, 1]]) }]);
    for (let i = 0; i < 5; i++) {
      await seed(`notes/filler-${i}`, `Filler ${i}`, [{ text: `unrelated filler text number ${i}`, emb: vec([[100 + i, 1], [7, 0.2]]) }]);
    }
    const kw = await engine.searchKeyword('zebra migration', { limit: 10 });
    const vq = await engine.searchVector(vec([[7, 1]]), { limit: 10 });
    expect(`${kw[0].slug}#${kw[0].chunk_index}`).toBe('notes/page-a#1');
    expect(`${vq[0].slug}#${vq[0].chunk_index}`).toBe('notes/page-a#2');
    const out = await hybridSearch(engine, 'zebra migration', {
      queryEmbedFn: () => vec([[7, 1]]),
      intentWeighting: false,
      reranker: { enabled: false, topNIn: 0, topNOut: null } as any,
      graph_signals: false,
    });
    expect(out[0].slug).toBe('notes/page-a');
    expect(out[0].chunk_index).toBe(2);
    expect(out[1].slug).toBe('notes/page-b');
  }, 60_000);
});
