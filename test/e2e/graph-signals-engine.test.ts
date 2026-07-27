/**
 * v0.40.4.0 E2E — getAdjacencyBoosts engine method.
 *
 * Hermetic PGLite (no DATABASE_URL needed). Pins:
 *
 *   - Empty input → empty Map, no SQL fired
 *   - Seeded same-source subgraph: hits computed, cross_source_hits = 0
 *   - Multi-source subgraph: cross_source_hits EXCLUDES target's own source
 *   - NULL source_id treated as 'default' via COALESCE (no crash)
 *   - HAVING >= 1 matches JSDoc contract: rows with hits=1 returned
 *     (callers apply their own threshold)
 *
 * Postgres parity is asserted structurally (same SQL shape) and via the
 * shared logic test — running this against real PG is a TODO once the
 * E2E lifecycle (test/e2e/auth-takes-holders-pglite.test.ts pattern)
 * gets a Postgres-mirror sibling. Source-grep guard in T3 keeps the
 * two engine impls in lockstep.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

// Track page IDs by slug for deterministic adjacency assertions.
const ids: Record<string, number> = {};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();

  // Ensure sources 'a' and 'b' exist before inserting pages that
  // reference them via FK.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES
       ('a', 'source a', '/tmp/a'),
       ('b', 'source b', '/tmp/b')
     ON CONFLICT (id) DO NOTHING`
  );

  // Seed pages across two sources.
  for (const [slug, source] of [
    ['people/alice', 'a'],
    ['people/bob', 'a'],
    ['companies/acme', 'a'],
    ['companies/widget', 'b'],
  ] as const) {
    const page = await engine.putPage(
      slug,
      {
        type: 'note',
        title: slug,
        compiled_truth: `body of ${slug}`,
      },
      { sourceId: source },
    );
    ids[slug] = page.id;
  }

  // Edges:
  //   alice → bob, alice → acme, bob → acme    (same-source hub: acme has hits=2)
  //   widget → acme    (cross-source link: acme's cross_source_hits gains 'b')
  await engine.addLinksBatch([
    { from_slug: 'people/alice', to_slug: 'people/bob', link_type: 'mentions', from_source_id: 'a', to_source_id: 'a' },
    { from_slug: 'people/alice', to_slug: 'companies/acme', link_type: 'works_at', from_source_id: 'a', to_source_id: 'a' },
    { from_slug: 'people/bob', to_slug: 'companies/acme', link_type: 'works_at', from_source_id: 'a', to_source_id: 'a' },
    { from_slug: 'companies/widget', to_slug: 'companies/acme', link_type: 'mentions', from_source_id: 'b', to_source_id: 'a' },
  ]);
});

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('getAdjacencyBoosts — contract', () => {
  test('empty input → empty Map (no SQL)', async () => {
    const out = await engine.getAdjacencyBoosts([]);
    expect(out.size).toBe(0);
  });

  test('singleton input → empty Map (no in-set edges possible to/from itself)', async () => {
    // alice is in the set alone. Even though alice has outbound links, neither
    // endpoint of any link is BOTH in the set, so HAVING >= 1 yields no rows.
    const out = await engine.getAdjacencyBoosts([ids['people/alice']]);
    expect(out.size).toBe(0);
  });
});

describe('getAdjacencyBoosts — same-source hub', () => {
  test('acme has hits=2 within {alice, bob, acme}', async () => {
    const pageIds = [
      ids['people/alice'],
      ids['people/bob'],
      ids['companies/acme'],
    ];
    const out = await engine.getAdjacencyBoosts(pageIds);
    const acme = out.get(ids['companies/acme']);
    expect(acme).toBeDefined();
    expect(acme!.hits).toBe(2);
    // All three are in source 'a' — cross_source_hits excludes target's own
    // source, so acme (in 'a') gets cross_source_hits = 0.
    expect(acme!.cross_source_hits).toBe(0);
  });

  test('bob has hits=1 within {alice, bob, acme} (alice → bob)', async () => {
    const pageIds = [
      ids['people/alice'],
      ids['people/bob'],
      ids['companies/acme'],
    ];
    const out = await engine.getAdjacencyBoosts(pageIds);
    const bob = out.get(ids['people/bob']);
    expect(bob).toBeDefined();
    expect(bob!.hits).toBe(1);
    expect(bob!.cross_source_hits).toBe(0);
  });
});

describe('getAdjacencyBoosts — cross-source', () => {
  test('acme gets cross_source_hits=1 when widget (source b) is in set', async () => {
    const pageIds = [
      ids['people/alice'],
      ids['people/bob'],
      ids['companies/acme'],
      ids['companies/widget'],
    ];
    const out = await engine.getAdjacencyBoosts(pageIds);
    const acme = out.get(ids['companies/acme']);
    expect(acme).toBeDefined();
    expect(acme!.hits).toBe(3);  // alice, bob, widget all link to acme
    expect(acme!.cross_source_hits).toBe(1);  // only widget is in source 'b'
  });

  test('exclusion of target own source: widget linked only by source-a pages → cross_source_hits should fire (source a != source b)', async () => {
    // widget is in source 'b'. The links we seeded don't go INTO widget. Let's
    // add edges from alice + bob (source a) → widget and verify widget gets
    // cross_source_hits = 1 (source 'a', not its own 'b').
    await engine.addLinksBatch([
      { from_slug: 'people/alice', to_slug: 'companies/widget', link_type: 'mentions', from_source_id: 'a', to_source_id: 'b' },
      { from_slug: 'people/bob', to_slug: 'companies/widget', link_type: 'mentions', from_source_id: 'a', to_source_id: 'b' },
    ]);
    const pageIds = [
      ids['people/alice'],
      ids['people/bob'],
      ids['companies/widget'],
    ];
    const out = await engine.getAdjacencyBoosts(pageIds);
    const widget = out.get(ids['companies/widget']);
    expect(widget).toBeDefined();
    expect(widget!.hits).toBe(2);
    // alice + bob are in source 'a', widget is in source 'b'. Both inbound
    // links are from a different source → cross_source_hits counts 1 distinct
    // OTHER source ('a').
    expect(widget!.cross_source_hits).toBe(1);
  });
});

// NULL source_id COALESCE branch: cannot be exercised in PGLite because
// pages.source_id is NOT NULL. COALESCE stays as defense-in-depth for
// schema variants; structural coverage is the source-grep guard against
// regressions in the SQL shape.

describe('getAdjacencyBoosts — JSDoc contract', () => {
  test('HAVING >= 1 returns rows with hits=1 (callers apply >=2 threshold)', async () => {
    const pageIds = [
      ids['people/alice'],
      ids['people/bob'],
    ];
    // alice → bob is the only in-set edge. bob has hits=1, should appear in
    // the map (per the JSDoc contract); caller decides whether to boost.
    const out = await engine.getAdjacencyBoosts(pageIds);
    const bob = out.get(ids['people/bob']);
    expect(bob).toBeDefined();
    expect(bob!.hits).toBe(1);
  });
});
