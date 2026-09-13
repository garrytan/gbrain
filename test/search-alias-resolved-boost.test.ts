// v0.42 Type Unification (T32) — alias_resolved search boost stage.
//
// Coverage: pages whose slug is a canonical_slug in slug_aliases get 1.05x
// score multiplier; non-alias-canonical pages unchanged; stage stamps
// alias_resolved_boost field for --explain; KNOBS_HASH_VERSION bumped.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPostFusionStages, type PostFusionOpts } from '../src/core/search/hybrid.ts';
import { KNOBS_HASH_VERSION } from '../src/core/search/mode.ts';
import type { SearchResult } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const noopPostFusionOpts: PostFusionOpts = {
  applyBacklinks: false,
  salience: 'off',
  recency: 'off',
  graphSignalsEnabled: false,
};

async function candidate(slug: string, sourceId = 'default'): Promise<SearchResult> {
  const page = await engine.putPage(slug, {
    title: slug, type: 'concept', compiled_truth: 'Synthetic alias fixture',
  }, { sourceId });
  return {
    slug, source_id: sourceId, score: 1, chunk_id: page.id, page_id: page.id,
    chunk_text: '', chunk_index: 0, title: slug, type: 'concept', slug_lower: slug,
  } as unknown as SearchResult;
}

describe('alias_resolved boost stage', () => {
  it('applies 1.05x multiplier to pages that are canonicals of aliases', async () => {
    // A canonical alias must point at an actual page in the same source.
    const results = [await candidate('canonical-page'), await candidate('plain-page')];
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('default', 'old-name', 'canonical-page')`,
    );
    await runPostFusionStages(engine, results, noopPostFusionOpts);
    // canonical-page gets 1.05x boost
    expect(results[0].score).toBeCloseTo(1.05, 5);
    expect(results[0].alias_resolved_boost).toBe(1.05);
    // plain-page unchanged
    expect(results[1].score).toBeCloseTo(1.0, 5);
    expect(results[1].alias_resolved_boost).toBeUndefined();
  });

  it('does not boost when no aliases exist', async () => {
    const results = [await candidate('plain')];
    await runPostFusionStages(engine, results, noopPostFusionOpts);
    expect(results[0].score).toBeCloseTo(1.0, 5);
    expect(results[0].alias_resolved_boost).toBeUndefined();
  });

  it('is source-scoped (F9): alias in source A does not boost in source B', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('alt', 'alt') ON CONFLICT DO NOTHING`);
    const results = [await candidate('shared'), await candidate('shared', 'alt')];
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('alt', 'old', 'shared')`,
    );
    // Both namesakes exist, but only the alias's exact source gets the boost.
    await runPostFusionStages(engine, results, noopPostFusionOpts);
    expect(results[0].alias_resolved_boost).toBeUndefined();
    expect(results[1].alias_resolved_boost).toBe(1.05);
  });
});

describe('KNOBS_HASH_VERSION', () => {
  it('is 29 (…; 25→26 salience/recency + intent_patterns fold #4415; 26→27 adaptive-return gate + intent fold E5b/F11; 27→28 compiledTruthBoost synthetic-row suppression #4256; 28→29 evb= expansion variant budget fold)', () => {
    // mw2: 21→22 result-stamp/injection epoch (#1663 #3995 #3783 #4220).
    // #4352 follow-up: 22→23 private-visibility posture fold (xp=).
    // #4358 residual: 23→24 negative-offset cache-skip gap.
    // 24→25: kof= (keyword AND→OR fallback knob) joins the key.
    // 25→26: sal=/rec=/ipat= — salience/recency + intent_patterns fold (#4415).
    // 26→27: ar=/arem=/arom=/armk=/ari= adaptive-return gate + intent fold
    // (2026-08 wave E5b/F11); also covers the same-release #3617 relaxed-row
    // fusion-demotion behavioral change (one bump per wave).
    // 27→28: compiledTruthBoost synthetic-row suppression (#4256/#3695) —
    // version-only invalidation.
    // 28→29: evb= expansion variant budget fold (ranker wave) — budget-weighted
    // variant fusion reorders rows for identical knobs; null hashes as legacy.
    expect(KNOBS_HASH_VERSION).toBe(29);
  });
});
