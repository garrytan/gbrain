/**
 * runPostFusionStages must honor operator recency config (GBRAIN_RECENCY_DECAY
 * env / gbrain.yml `recency:`), not just the baked-in DEFAULT_RECENCY_DECAY.
 *
 * Regression guard: the hybrid recency stage previously imported
 * DEFAULT_RECENCY_DECAY directly, so overrides reached only the
 * get_recent_salience SQL path and were silently dropped on the hot
 * hybridSearch path. These tests pin a custom prefix via the env var and
 * assert the boost the hybrid path applies reflects that config.
 */

import { describe, test, expect } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import { runPostFusionStages } from '../src/core/search/hybrid.ts';
import type { SearchResult } from '../src/core/types.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const DAY_MS = 86_400_000;
// DEFAULT_FALLBACK from recency-decay.ts, mirrored to keep the test focused on
// the function under test (the value an unpatched hybrid path would apply).
const DEFAULT_FALLBACK_HL = 90;
const DEFAULT_FALLBACK_COEFF = 0.5;

/**
 * Minimal engine stub: only getEffectiveDates is exercised because the test
 * disables backlinks/salience. Every result is dated `daysOld` ago so the
 * decay factor is deterministic. Other methods throw to surface accidental use.
 */
function makeEngine(daysOld: number): BrainEngine {
  const d = new Date(Date.now() - daysOld * DAY_MS);
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'getEffectiveDates') {
        return async (refs: Array<{ slug: string; source_id: string }>) => {
          const m = new Map<string, Date>();
          for (const r of refs) m.set(`${r.source_id}::${r.slug}`, d);
          return m;
        };
      }
      return () => { throw new Error(`unexpected engine call: ${String(prop)}`); };
    },
  }) as unknown as BrainEngine;
}

function makeResult(slug: string): SearchResult {
  return {
    slug,
    page_id: 1,
    title: slug,
    type: 'note',
    chunk_text: 'x',
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score: 1.0,
    stale: false,
    source_id: 'default',
  } as unknown as SearchResult;
}

const RECENCY_ONLY = { applyBacklinks: false, salience: 'off', recency: 'on' } as const;

describe('runPostFusionStages recency config wiring', () => {
  test('GBRAIN_RECENCY_DECAY evergreen override suppresses the boost on the hybrid path', async () => {
    // `custom/` is absent from DEFAULT_RECENCY_DECAY. Without honoring the env,
    // the slug falls to DEFAULT_FALLBACK (90d/0.5) and gets boosted. Declaring
    // it evergreen (0/0) must short-circuit the boost — proof the env reached
    // the hybrid stage.
    await withEnv({ GBRAIN_RECENCY_DECAY: 'custom/:0:0' }, async () => {
      const results = [makeResult('custom/foo')];
      await runPostFusionStages(makeEngine(30), results, RECENCY_ONLY);

      expect(results[0].recency_boost).toBeUndefined();
      expect(results[0].score).toBe(1.0);
    });
  });

  test('GBRAIN_RECENCY_DECAY custom coefficient/halflife flows into the applied factor', async () => {
    // Pin an aggressive config for a prefix the defaults don't carry. The
    // applied factor must match the custom config, not DEFAULT_FALLBACK.
    const halflife = 14, coefficient = 2.0, daysOld = 14;
    await withEnv({ GBRAIN_RECENCY_DECAY: `custom/:${halflife}:${coefficient}` }, async () => {
      const results = [makeResult('custom/foo')];
      await runPostFusionStages(makeEngine(daysOld), results, RECENCY_ONLY);

      // factor = 1 + coefficient * halflife / (halflife + daysOld); at daysOld==halflife → 1 + coefficient/2.
      const expected = 1 + coefficient * halflife / (halflife + daysOld);
      const fallbackFactor = 1 + DEFAULT_FALLBACK_COEFF * DEFAULT_FALLBACK_HL / (DEFAULT_FALLBACK_HL + daysOld);
      expect(results[0].recency_boost).toBeCloseTo(expected, 4);
      // Sanity: the custom factor is distinguishable from the fallback the
      // unpatched hybrid path would have applied.
      expect(Math.abs(expected - fallbackFactor)).toBeGreaterThan(0.1);
    });
  });
});
