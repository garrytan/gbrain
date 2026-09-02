/**
 * Documents CM1 of the brain-plane repair plan: a source-scoped QUEUED cycle
 * (`autopilot-cycle` with source_id) is normalized to the freshness phases,
 * so global phases (embed, orphans, purge) submitted on the source lane are
 * DROPPED, not run. The global lane (`autopilot-global-maintenance`) owns
 * them. A payload without source_id is untouched.
 */
import { describe, test, expect } from 'bun:test';
import { normalizeQueuedSourcePhases, SOURCE_FRESHNESS_PHASES, GLOBAL_PHASES } from '../src/core/cycle.ts';

describe('normalizeQueuedSourcePhases', () => {
  test('source lane: global phases are dropped and reported as rejected', () => {
    const requested = ['lint', 'backlinks', 'extract', 'extract_facts', 'recompute_emotional_weight', 'embed', 'orphans', 'purge'] as const;
    const { phases, rejected } = normalizeQueuedSourcePhases([...requested], 'default');
    expect(phases).toEqual(['lint', 'backlinks', 'extract', 'extract_facts', 'recompute_emotional_weight']);
    expect(rejected).toEqual(['embed', 'orphans', 'purge']);
    for (const p of rejected) expect(GLOBAL_PHASES).toContain(p);
  });

  test('source lane: every freshness phase survives; the mixed phases do not', () => {
    const { phases, rejected } = normalizeQueuedSourcePhases([...SOURCE_FRESHNESS_PHASES, 'synthesize', 'patterns'], 'wiki');
    expect(phases).toEqual([...SOURCE_FRESHNESS_PHASES]);
    expect(rejected).toEqual(['synthesize', 'patterns']);
  });

  test('no source_id: the list passes through verbatim', () => {
    const { phases, rejected } = normalizeQueuedSourcePhases(['embed', 'orphans', 'purge'], undefined);
    expect(phases).toEqual(['embed', 'orphans', 'purge']);
    expect(rejected).toEqual([]);
  });

  test('no explicit list: undefined passes through (the cycle picks the default set)', () => {
    expect(normalizeQueuedSourcePhases(undefined, 'default')).toEqual({ phases: undefined, rejected: [] });
  });
});
