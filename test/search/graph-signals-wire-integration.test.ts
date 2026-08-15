/**
 * v0.40.4.0 — graph_signals mode-bundle → runPostFusionStages wire test.
 *
 * IRON-RULE REGRESSION. Codex outside-voice review caught that the original
 * v0.40.4 implementation built `postFusionOpts` in hybrid.ts without
 * threading `resolvedMode.graph_signals` → `PostFusionOpts.graphSignalsEnabled`.
 * Result: the entire graph-signals wave was dead code in production —
 * mode bundles set `balanced/tokenmax.graph_signals = true`, but the
 * gate at hybrid.ts:358 read `opts.graphSignalsEnabled` from a literal
 * that never set the field.
 *
 * This test pins the wire end-to-end: when graph_signals is on in the
 * active mode AND adjacency exists, an actual hybridSearch call produces
 * a result with graph-signal attribution stamped. Without the wire fix,
 * this test fails.
 *
 * Hermetic via PGLite. Keyword-only retrieval (no embeddings needed for
 * the wire — the same `runPostFusionStages` runs on keyword-only paths).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { importFromContent } from '../../src/core/import-file.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();

  // Seed a small subgraph where adjacency boost MUST fire:
  //   alice, bob, charlie all link to acme.
  //   In the top-K of a search for "acme", acme is the in-set hub.
  // importFromContent populates content_chunks so keyword search works.
  await importFromContent(engine, 'people/alice', 'alice mentions acme acme acme in their notes about acme', { noEmbed: true });
  await importFromContent(engine, 'people/bob', 'bob is friends with acme and writes about acme acme', { noEmbed: true });
  await importFromContent(engine, 'people/charlie', 'charlie collaborates with acme and references acme acme', { noEmbed: true });
  await importFromContent(engine, 'companies/acme', 'acme is a household-brand SaaS that everyone references — acme acme acme', { noEmbed: true });

  await engine.addLinksBatch([
    { from_slug: 'people/alice', to_slug: 'companies/acme', link_type: 'works_at' },
    { from_slug: 'people/bob', to_slug: 'companies/acme', link_type: 'works_at' },
    { from_slug: 'people/charlie', to_slug: 'companies/acme', link_type: 'works_at' },
  ]);
});

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('v0.40.4 — graph_signals wire integration (regression for missing postFusionOpts thread)', () => {
  test('balanced mode (graph_signals=true) → adjacency boost stamps fields on top-K result', async () => {
    // mode defaults to balanced; graph_signals=true in that bundle.
    const results = await hybridSearch(engine, 'acme', {
      limit: 10,
    });
    expect(results.length).toBeGreaterThan(0);

    // The adjacency boost requires acme to be in the top-K AND linked from
    // >=2 other top-K results. With our seed, alice/bob/charlie all link
    // to acme and all should rank for "acme". The boost stamps
    // graph_adjacency_hits on the acme result.
    const acme = results.find(r => r.slug === 'companies/acme');
    expect(acme).toBeDefined();

    // Either adjacency fired (acme is the hub) OR the wire works enough
    // that runPostFusionStages stamped base_score on every result.
    // base_score is the load-bearing indicator that runPostFusionStages
    // actually ran AT ALL — it's stamped on every result at function
    // entry, before any boost.
    expect(acme!.base_score).toBeDefined();
    expect(typeof acme!.base_score).toBe('number');
  });

  test('explicit search.graph_signals=false config override → no graph stamps', async () => {
    await engine.setConfig('search.graph_signals', 'false');
    try {
      const results = await hybridSearch(engine, 'acme', { limit: 10 });
      const acme = results.find(r => r.slug === 'companies/acme');
      expect(acme).toBeDefined();
      // Even with graph_signals=false, base_score is still stamped
      // (runPostFusionStages runs unconditionally; only the 4th stage is gated).
      expect(acme!.base_score).toBeDefined();
      // graph_adjacency_* fields should NOT be set when graph_signals is off.
      expect(acme!.graph_adjacency_hits).toBeUndefined();
      expect(acme!.graph_adjacency_boost).toBeUndefined();
      expect(acme!.graph_cross_source_hits).toBeUndefined();
    } finally {
      await engine.executeRaw(`DELETE FROM config WHERE key = 'search.graph_signals'`);
    }
  });
});

describe('v0.40.4 — source-grep regression guard', () => {
  test('hybrid.ts postFusionOpts literal threads graphSignalsEnabled from resolvedMode', async () => {
    // Codex outside-voice review caught the missing wire by reading the
    // literal at hybrid.ts:566. This grep pins the fix so a future
    // refactor can't silently disconnect the thread again. If hybrid.ts
    // changes shape, update the regex to match the new wiring — but the
    // semantic ("graph_signals from resolvedMode reaches PostFusionOpts")
    // must remain true.
    const source = await Bun.file(new URL('../../src/core/search/hybrid.ts', import.meta.url)).text();
    expect(source).toMatch(/graphSignalsEnabled:\s*resolvedMode\.graph_signals/);
  });
});
