// test/remediation-context-extraction-lag.test.ts
//
// Pins the v-next fix: the sync→extract remediation pipeline gates on REAL
// extraction lag, not the legacy `health.stale_pages` proxy (which counted
// "updated_at predates newest timeline entry" — meaningless after the v10
// trigger drop). loadRecommendationContext now populates `extractionLagPages`
// from `engine.countStalePagesForExtraction` — the SAME counter the
// `gbrain extract --stale` walk and doctor's `links_extraction_lag` use — so a
// recommendation can only fire when running extract will actually reduce it.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadRecommendationContext } from '../src/core/remediation/context.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('loadRecommendationContext — extractionLagPages wiring', () => {
  it('is 0 on an empty brain (nothing to extract)', async () => {
    const ctx = await loadRecommendationContext(engine);
    expect(ctx.extractionLagPages).toBe(0);
  });

  it('reflects the real extraction-lag count once a page needs extraction', async () => {
    // A freshly-imported page has links_extracted_at = NULL, which the canonical
    // countStalePagesForExtraction predicate counts as stale-for-extraction.
    await engine.putPage('p0', {
      title: 'p0',
      type: 'note' as never,
      compiled_truth: 'body that is long enough to pass any minimum-length guards in the codebase',
      timeline: '',
      frontmatter: {},
      source_path: 'p0.md',
    });
    const ctx = await loadRecommendationContext(engine);
    expect(ctx.extractionLagPages).toBeGreaterThan(0);
  });
});
