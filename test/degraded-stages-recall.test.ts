/**
 * v0.48.2 — ranking-only degraded stages never count as recall impairment.
 * `affectsRecall` is the ONE predicate behind the short degraded cache TTL
 * (hybridSearchCached), the MCP empty-result block (dispatch.ts) and the CLI
 * "clean miss" copy (cli.ts); pin it here so a regression to a length check
 * cannot pass the two e2e extremes unnoticed.
 */
import { describe, expect, test } from 'bun:test';
import { DEGRADED_STAGES, RANKING_ONLY_DEGRADED_STAGES, affectsRecall } from '../src/core/types.ts';

describe('affectsRecall', () => {
  test('reranker_skipped is ranking-only', () => {
    expect(RANKING_ONLY_DEGRADED_STAGES.has('reranker_skipped')).toBe(true);
    expect(affectsRecall({ stage: 'reranker_skipped', reason: 'no_key' })).toBe(false);
    expect(affectsRecall({ stage: 'reranker_skipped', reason: 'sunset_short_circuit' })).toBe(false);
  });

  test('every other closed-vocabulary stage affects recall', () => {
    for (const stage of DEGRADED_STAGES) {
      if (RANKING_ONLY_DEGRADED_STAGES.has(stage)) continue;
      expect(affectsRecall({ stage })).toBe(true);
    }
  });

  test('a mixed list is degraded iff any recall-affecting stage is present', () => {
    const mixed = [{ stage: 'reranker_skipped' }, { stage: 'expansion_partial' }];
    expect(mixed.some(affectsRecall)).toBe(true);
    expect([{ stage: 'reranker_skipped' }].some(affectsRecall)).toBe(false);
    expect(affectsRecall(undefined)).toBe(false);
    expect(affectsRecall({})).toBe(false);
  });

  test("master's transient stages stay recall-affecting on purpose (merge-time taxonomy decision)", () => {
    // rerank_passthrough: provider answered 200 with an empty/malformed set — a
    // transient fault; the short degraded TTL is what lets the next query recover.
    expect(affectsRecall({ stage: 'rerank_passthrough', reason: 'empty_result_set' })).toBe(true);
    expect(affectsRecall({ stage: 'rerank_passthrough', reason: 'malformed_shape' })).toBe(true);
    // keyword_relaxed_carried: OR-relaxed rows voted in fusion — recall-shaped.
    expect(affectsRecall({ stage: 'keyword_relaxed_carried' })).toBe(true);
    // The ranking-only set is exactly the config-state skip.
    expect([...RANKING_ONLY_DEGRADED_STAGES]).toEqual(['reranker_skipped']);
  });
});
