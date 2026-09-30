/**
 * Auto-detected entity intent ("who is …", "tell me about …") suggests
 * detail=low. It used to hard-filter every arm to compiled_truth in SQL, and
 * the zero-result escalation only covered an EXPLICIT low, so a timeline-only
 * answer was invisible. Auto low is now a soft preference: no SQL filter, a
 * mild compiled-truth tilt. An explicit `detail: 'low'` keeps the filter.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';
import { installPageProjection, readProjectionSnapshot } from '../../src/core/page-state/projections.ts';
import {
  AUTO_LOW_COMPILED_TRUTH_TILT,
  compiledTruthFusionBoost,
  hybridSearch,
  rrfFusionWeighted,
} from '../../src/core/search/hybrid.ts';
import { classifyQuery } from '../../src/core/search/query-intent.ts';
import type { HybridSearchMeta, SearchResult } from '../../src/core/types.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

async function seed(slug: string, type: string, chunks: Array<{ text: string; source: 'compiled_truth' | 'timeline'; dim: number }>, title: string) {
  const ct = chunks.filter(c => c.source === 'compiled_truth').map(c => c.text).join('\n');
  const tl = chunks.filter(c => c.source === 'timeline').map(c => c.text).join('\n');
  await engine.putPage(slug, { type, title, compiled_truth: ct, timeline: tl } as any);
  const snap = (await readProjectionSnapshot(engine, slug, 'default', { allowUnsealed: true }))!;
  await installPageProjection(engine, snap, chunks.map((c, i) => ({
    chunk_index: i, chunk_text: c.text, chunk_source: c.source, embedding: basisEmbedding(c.dim, 1536), token_count: 10,
  })) as any, { seal: true });
}

const noRerank = { enabled: false, topNIn: 0, topNOut: null } as any;
const QUERY = 'who is the founder of the Widget Guild';

describe('auto entity intent: detail=low is a soft preference', () => {
  test('the probe query classifies as entity / low', () => {
    expect(classifyQuery(QUERY).intent).toBe('entity');
    expect(classifyQuery(QUERY).suggestedDetail).toBe('low');
  });

  test('a timeline-only answer is found under auto detail', async () => {
    await seed('meetings/2024-03-01-guild', 'meeting', [
      { text: 'Guild kickoff: Alice Example founded the Widget Guild and chairs it.', source: 'timeline', dim: 7 },
    ], 'Kickoff');
    await seed('notes/unrelated', 'note', [{ text: 'Grocery list: apples and bread.', source: 'compiled_truth', dim: 9 }], 'Groceries');
    let meta: HybridSearchMeta | undefined;
    const auto = await hybridSearch(engine, QUERY, {
      queryEmbedFn: () => basisEmbedding(7, 1536), reranker: noRerank, onMeta: (m) => { meta = m; },
    });
    expect(auto[0]?.slug).toBe('meetings/2024-03-01-guild');
    expect(auto[0]?.chunk_source).toBe('timeline');
    expect(meta?.detail_resolved).toBe('low');
  }, 60_000);

  test('an explicit detail=low still hard-filters to compiled truth', async () => {
    await seed('meetings/2024-03-01-guild', 'meeting', [
      { text: 'Guild kickoff: Alice Example founded the Widget Guild and chairs it.', source: 'timeline', dim: 7 },
    ], 'Kickoff');
    await seed('notes/unrelated', 'note', [{ text: 'Grocery list: apples and bread.', source: 'compiled_truth', dim: 9 }], 'Groceries');
    const explicit = await hybridSearch(engine, QUERY, {
      queryEmbedFn: () => basisEmbedding(7, 1536), reranker: noRerank, detail: 'low',
    });
    expect(explicit.every(r => r.chunk_source === 'compiled_truth')).toBe(true);
  }, 60_000);

  test('boost argument: explicit low = full boost, auto low = soft tilt, others = none', () => {
    expect(compiledTruthFusionBoost('low', 'low')).toBe(true);
    expect(compiledTruthFusionBoost('low', undefined)).toBe(AUTO_LOW_COMPILED_TRUTH_TILT);
    expect(compiledTruthFusionBoost('medium', undefined)).toBe(false);
    expect(compiledTruthFusionBoost(undefined, undefined)).toBe(false);
    expect(compiledTruthFusionBoost('high', 'high')).toBe(false);
  });

  test('the soft tilt multiplies compiled_truth rows by the tilt, not 2x', () => {
    const r = (slug: string, source: 'compiled_truth' | 'timeline'): SearchResult => ({
      slug, page_id: 1, title: slug, type: 'note', chunk_text: slug, chunk_source: source, chunk_id: 1, chunk_index: 0, score: 0, stale: false,
    } as SearchResult);
    const out = rrfFusionWeighted([{ list: [r('tl', 'timeline'), r('ct', 'compiled_truth')], k: 60 }], AUTO_LOW_COMPILED_TRUTH_TILT);
    const ct = out.find(x => x.slug === 'ct')!;
    expect(ct.score).toBeCloseTo((60 / 61) * AUTO_LOW_COMPILED_TRUTH_TILT, 12);
    expect(out[0].slug).toBe('ct');
  });
});
