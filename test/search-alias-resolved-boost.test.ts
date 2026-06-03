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

describe('alias_resolved boost stage', () => {
  it('applies 1.05x multiplier to pages that are canonicals of aliases', async () => {
    // Insert an alias pointing at canonical-page
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('default', 'old-name', 'canonical-page')`,
    );
    const results: SearchResult[] = [
      {
        slug: 'canonical-page', source_id: 'default', score: 1.0,
        chunk_id: 1, page_id: 1, chunk_text: '', chunk_index: 0,
        title: 'Canonical', type: 'concept' as never, slug_lower: 'canonical-page',
      } as unknown as SearchResult,
      {
        slug: 'plain-page', source_id: 'default', score: 1.0,
        chunk_id: 2, page_id: 2, chunk_text: '', chunk_index: 0,
        title: 'Plain', type: 'concept' as never, slug_lower: 'plain-page',
      } as unknown as SearchResult,
    ];
    await runPostFusionStages(engine, results, noopPostFusionOpts);
    // canonical-page gets 1.05x boost
    expect(results[0].score).toBeCloseTo(1.05, 5);
    expect(results[0].alias_resolved_boost).toBe(1.05);
    // plain-page unchanged
    expect(results[1].score).toBeCloseTo(1.0, 5);
    expect(results[1].alias_resolved_boost).toBeUndefined();
  });

  it('does not boost when no aliases exist', async () => {
    const results: SearchResult[] = [{
      slug: 'plain', source_id: 'default', score: 1.0,
      chunk_id: 1, page_id: 1, chunk_text: '', chunk_index: 0,
      title: 'p', type: 'concept' as never, slug_lower: 'plain',
    } as unknown as SearchResult];
    await runPostFusionStages(engine, results, noopPostFusionOpts);
    expect(results[0].score).toBeCloseTo(1.0, 5);
    expect(results[0].alias_resolved_boost).toBeUndefined();
  });

  it('is source-scoped (F9): alias in source A does not boost in source B', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('alt', 'alt') ON CONFLICT DO NOTHING`);
    await engine.executeRaw(
      `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('alt', 'old', 'shared')`,
    );
    // Same slug, different source — should NOT be boosted (alias is in 'alt')
    const results: SearchResult[] = [{
      slug: 'shared', source_id: 'default', score: 1.0,
      chunk_id: 1, page_id: 1, chunk_text: '', chunk_index: 0,
      title: 's', type: 'concept' as never, slug_lower: 'shared',
    } as unknown as SearchResult];
    await runPostFusionStages(engine, results, noopPostFusionOpts);
    expect(results[0].alias_resolved_boost).toBeUndefined();
  });
});

describe('KNOBS_HASH_VERSION', () => {
  it('is 9 (8→9 archive-demote invalidates archive-excluded cache rows, #1777)', () => {
    expect(KNOBS_HASH_VERSION).toBe(9);
  });
});
