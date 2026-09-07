/**
 * capture.ts — the `--capture-pool` receipt fields (plan D24). Pins that the
 * captured pool mirrors hybrid.ts's autocut inputs field for field and that
 * `autocut_kept_keys` is only emitted when the returned rows ARE the kept set.
 */
import { describe, test, expect } from 'bun:test';
import type { HybridSearchMeta, SearchResult } from '../src/core/types.ts';
import { buildCaptureExtras, poolKey } from '../src/eval/longmemeval/capture.ts';
import { buildSlugToRawMap } from '../src/eval/longmemeval/metrics.ts';
import type { LongMemEvalQuestion } from '../src/eval/longmemeval/adapter.ts';

function row(slug: string, chunk_id: number, over: Partial<SearchResult> = {}): SearchResult {
  return {
    slug, page_id: 1, title: slug, type: 'note', chunk_text: 'some chunk text here', chunk_source: 'compiled_truth',
    chunk_id, chunk_index: 0, score: 0.5, stale: false, ...over,
  } as SearchResult;
}

const Q = {
  question_id: 'q', question_type: 'single-session-user', question: 'q?', answer: 'a',
  haystack_session_ids: ['Sess_A', 'Sess_B', 'Sess_C'],
  haystack_sessions: [[], [], []],
  answer_session_ids: ['Sess_A'],
} as unknown as LongMemEvalQuestion;
const MAP = buildSlugToRawMap(Q);

const autocutMeta = (kept: number, total: number): HybridSearchMeta =>
  ({ vector_enabled: true, autocut: { applied: true, signal: 'rerank', cut: kept, kept, total, gapRatio: 0.5 } } as unknown as HybridSearchMeta);

describe('poolKey', () => {
  test('is the `slug#chunk_id` template the autocut replay compares against', () => {
    expect(poolKey(row('chat/sess-a', 7))).toBe('chat/sess-a#7');
    expect(poolKey(row('chat/x', 0))).toBe('chat/x#0');
  });
});

describe('buildCaptureExtras', () => {
  const pool = [
    row('chat/sess-b', 2, { rerank_score: 0.9 }),
    row('chat/sess-a', 1, { rerank_score: 0.8 }),
    row('chat/sess-c', 3, { alias_hit: true }),                       // unscored alias hop
    row('chat/sess-c', 4, { exact_lookup: 'title' }),                 // unscored exact lookup
    row('chat/sess-b', 5, { rerank_score: 0.1, relational_pinned: true }),
  ];
  // Pre-rerank (RRF) order differs from pool order; the last pool row is absent from it.
  const preRerank = [pool[1], pool[0], pool[2], pool[3]];

  test('no pool captured → {} (nothing stamped)', () => {
    expect(buildCaptureExtras({ pool: undefined, preRerank, meta: autocutMeta(2, 5), results: pool.slice(0, 2), slugToRaw: MAP })).toEqual({});
  });

  test('rerank_pool: every pool row in pool order with raw session id, RRF rank, pool rank, est_tokens, and the flags only when set', () => {
    const { rerank_pool } = buildCaptureExtras({ pool, preRerank, meta: undefined, results: pool, slugToRaw: MAP });
    expect(rerank_pool).toHaveLength(5);
    expect(rerank_pool!.map(r => r.pool_rank)).toEqual([1, 2, 3, 4, 5]);
    expect(rerank_pool!.map(r => r.session_id)).toEqual(['Sess_B', 'Sess_A', 'Sess_C', 'Sess_C', 'Sess_B']); // RAW ids through the map
    expect(rerank_pool!.map(r => r.rrf_rank)).toEqual([2, 1, 3, 4, 5]); // pre-rerank position; the unmapped last row falls back to its pool position
    expect(rerank_pool!.map(r => r.chunk_id)).toEqual([2, 1, 3, 4, 5]);
    for (const r of rerank_pool!) expect(r.est_tokens).toBeGreaterThan(0);
    // Scored rows carry rerank_score; unscored rows do not carry the key at all.
    expect(rerank_pool![0].rerank_score).toBe(0.9);
    expect('rerank_score' in rerank_pool![2]).toBe(false);
    expect('rerank_score' in rerank_pool![3]).toBe(false);
    // Flags are stamped ONLY on the rows that set them (as `true`), never as false/undefined keys.
    expect(rerank_pool![2]).toMatchObject({ alias_hit: true });
    expect(rerank_pool![3]).toMatchObject({ exact_lookup: true });
    expect(rerank_pool![4]).toMatchObject({ relational_pinned: true });
    for (const [i, r] of rerank_pool!.entries()) {
      expect('alias_hit' in r).toBe(i === 2);
      expect('exact_lookup' in r).toBe(i === 3);
      expect('relational_pinned' in r).toBe(i === 4);
    }
  });

  test('autocut_kept_keys: present iff autocut recorded a decision AND kept === results.length; equals results.map(poolKey)', () => {
    const results = pool.slice(0, 2);
    const exact = buildCaptureExtras({ pool, preRerank, meta: autocutMeta(2, 5), results, slugToRaw: MAP });
    expect(exact.autocut_kept_keys).toEqual(['chat/sess-b#2', 'chat/sess-a#1']);
    expect(exact.autocut_kept_keys).toEqual(results.map(poolKey));
    // A further limit/budget slice hid the exact set → absent (replay falls back to count/gap validation).
    const sliced = buildCaptureExtras({ pool, preRerank, meta: autocutMeta(3, 5), results, slugToRaw: MAP });
    expect('autocut_kept_keys' in sliced).toBe(false);
    expect(sliced.rerank_pool).toHaveLength(5);
    // No autocut decision on the meta → absent.
    const noDecision = buildCaptureExtras({ pool, preRerank, meta: { vector_enabled: true } as unknown as HybridSearchMeta, results, slugToRaw: MAP });
    expect('autocut_kept_keys' in noDecision).toBe(false);
    const noMeta = buildCaptureExtras({ pool, preRerank, meta: undefined, results, slugToRaw: MAP });
    expect('autocut_kept_keys' in noMeta).toBe(false);
  });

  test('no pre-rerank rows → every rrf_rank is the pool position', () => {
    const { rerank_pool } = buildCaptureExtras({ pool, preRerank: undefined, meta: undefined, results: pool, slugToRaw: MAP });
    expect(rerank_pool!.map(r => r.rrf_rank)).toEqual([1, 2, 3, 4, 5]);
  });
});
