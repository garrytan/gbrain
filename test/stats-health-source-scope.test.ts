/**
 * #4592 — get_stats / get_health / get_brain_identity honor the caller's
 * source scope.
 *
 * The leak class: aggregates leak by SUBTRACTION. Since #4433 confined
 * sources_list, a source-scoped remote grant could still recover an excluded
 * source's page count (and type mix) by comparing get_stats against its own
 * scoped reads. This suite pins the closure at three layers:
 *
 *  - ENGINE: getStats/getHealth take an optional scope; every counter,
 *    coverage numerator AND denominator, and degree confines to it. A link
 *    contributes only when BOTH endpoints are in scope (X8: a
 *    granted→ungranted edge must not leak the far side through a degree,
 *    nor rescue a page from orphan-hood).
 *  - FAIL-CLOSED SHAPES (T11): an explicit empty sourceIds array and the
 *    remote `__all__` sentinel scalar both produce ZEROS, never brain-wide.
 *  - OP LAYER (#4433 ladder): trusted local (`remote === false`) keeps the
 *    brain-wide view; every remote shape (scalar / federated array /
 *    sentinel) is confined. get_brain_identity rides the same ladder (it is
 *    read-scope and was the quiet third aggregate surface).
 *
 * The differential assertion at the bottom is the class-closer: mutating an
 * EXCLUDED source must not move any number a scoped caller can see.
 *
 * PGLite-backed with a DATABASE_URL-gated real-Postgres parity arm (same
 * seed, same assertions — the engines' scope predicates must agree).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const SRCA = 'scopesrca';
const SRCB = 'scopesrcb';

async function seed(engine: BrainEngine): Promise<void> {
  // Direct row inserts: sources_add demands a committed git repo; the
  // registration row is all the scope predicates key on (same pattern as
  // test/remote-privacy-sweep.test.ts).
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('${SRCA}', '${SRCA}'), ('${SRCB}', '${SRCB}')
     ON CONFLICT (id) DO NOTHING`,
  );
  const put = async (sourceId: string, slug: string, title: string, type: string, body: string) => {
    await engine.putPage(slug, { title, type, compiled_truth: `# ${title}\n\n${body}\n` }, { sourceId });
  };
  await put(SRCA, 'people/alice-example', 'Alice Example', 'person', 'srca entity page');
  await put(SRCA, 'notes/alpha', 'Alpha Note', 'note', 'srca note page linking [[people/alice-example]]');
  await put(SRCB, 'people/bob-example', 'Bob Example', 'person', 'srcb entity page');
  const id = async (slug: string, src: string) => {
    const rows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = '${slug}' AND source_id = '${src}'`,
    );
    return rows[0].id;
  };
  const alice = await id('people/alice-example', SRCA);
  const alpha = await id('notes/alpha', SRCA);
  const bob = await id('people/bob-example', SRCB);
  // In-scope pair, granted→ungranted, ungranted→granted (the X8 seeds).
  await engine.executeRaw(
    `INSERT INTO links (from_page_id, to_page_id, link_type) VALUES
       (${alpha}, ${alice}, 'wikilink'),
       (${alice}, ${bob}, 'wikilink'),
       (${bob}, ${alpha}, 'wikilink')`,
  );
  await engine.executeRaw(
    `INSERT INTO timeline_entries (page_id, date, summary) VALUES
       (${alice}, '2026-08-01', 'srca event'),
       (${bob}, '2026-08-02', 'srcb event')`,
  );
  await engine.executeRaw(
    `INSERT INTO tags (page_id, tag) VALUES (${alpha}, 'srca-tag'), (${bob}, 'srcb-tag')
     ON CONFLICT DO NOTHING`,
  );
  // Direct chunk rows: engine.putPage alone doesn't chunk (that's the
  // import/ops layer); the scope predicate routes chunks through their page
  // join, which is what these rows pin.
  await engine.executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text) VALUES
       (${alice}, 0, 'srca chunk'), (${alpha}, 0, 'srca chunk 2'), (${bob}, 0, 'srcb chunk')`,
  );
}

function scopeAssertions(getEngine: () => BrainEngine) {
  test('unscoped view is brain-wide; scoped views confine every counter', async () => {
    const engine = getEngine();
    const all = await engine.getStats();
    const a = await engine.getStats({ sourceIds: [SRCA] });
    const b = await engine.getStats({ sourceIds: [SRCB] });
    const both = await engine.getStats({ sourceIds: [SRCA, SRCB] });

    expect(a.page_count).toBe(2);
    expect(b.page_count).toBe(1);
    expect(both.page_count).toBe(3);
    expect(all.page_count).toBeGreaterThanOrEqual(3);
    // Both-endpoint rule: srca alone sees ONLY alpha→alice; the two
    // cross-boundary edges vanish from every single-source view.
    expect(a.link_count).toBe(1);
    expect(b.link_count).toBe(0);
    expect(both.link_count).toBe(3);
    expect(a.tag_count).toBe(1);
    expect(b.tag_count).toBe(1);
    expect(a.timeline_entry_count).toBe(1);
    expect(b.timeline_entry_count).toBe(1);
    // pages_by_type confines too (the issue's named recoverable field).
    expect(a.pages_by_type.person).toBe(1);
    expect(a.pages_by_type.note).toBe(1);
    expect(b.pages_by_type.person).toBe(1);
    expect(b.pages_by_type.note).toBeUndefined();
    // Chunks route through their page joins.
    expect(a.chunk_count).toBe(2);
    expect(b.chunk_count).toBe(1);
    expect(a.chunk_count + b.chunk_count).toBe(both.chunk_count);
  });

  test('T11 fail-closed shapes: empty grant array and the __all__ sentinel produce zeros', async () => {
    const engine = getEngine();
    for (const scope of [{ sourceIds: [] as string[] }, { sourceId: '__all__' }]) {
      const s = await engine.getStats(scope);
      expect(s.page_count).toBe(0);
      expect(s.chunk_count).toBe(0);
      expect(s.link_count).toBe(0);
      expect(s.tag_count).toBe(0);
      expect(s.timeline_entry_count).toBe(0);
      expect(Object.keys(s.pages_by_type)).toHaveLength(0);
      const h = await engine.getHealth(scope);
      expect(h.page_count).toBe(0);
      expect(h.entity_page_count).toBe(0);
      expect(h.most_connected).toHaveLength(0);
    }
  });

  test('X8: degrees, denominators, and the islanded predicate scope by BOTH endpoints', async () => {
    const engine = getEngine();
    const hA = await engine.getHealth({ sourceIds: [SRCA] });
    // Alice's degree inside srca: alpha→alice only (her edge to bob and
    // bob's edge to alpha are out-of-scope on the far end).
    const alice = hA.most_connected.find(m => m.slug === 'people/alice-example');
    expect(alice?.link_count).toBe(1);
    expect(hA.most_connected.some(m => m.slug === 'people/bob-example')).toBe(false);
    // entity denominator = srca entities only.
    expect(hA.entity_page_count).toBe(1);

    const hB = await engine.getHealth({ sourceIds: [SRCB] });
    // Bob's only edges cross the boundary: inside srcb he is islanded and
    // his degree is zero — the far side must not rescue or leak.
    const bob = hB.most_connected.find(m => m.slug === 'people/bob-example');
    expect(bob?.link_count).toBe(0);
    expect(hB.orphan_pages).toBeGreaterThanOrEqual(1);

    const hBoth = await engine.getHealth({ sourceIds: [SRCA, SRCB] });
    const bobBoth = hBoth.most_connected.find(m => m.slug === 'people/bob-example');
    expect(bobBoth?.link_count).toBe(2);
  });

  test('differential class-closer: mutating an EXCLUDED source moves nothing a scoped caller sees', async () => {
    const engine = getEngine();
    const before = await engine.getStats({ sourceIds: [SRCA] });
    const beforeHealth = await engine.getHealth({ sourceIds: [SRCA] });
    await engine.putPage('notes/hidden-growth', { title: 'Hidden Growth', type: 'note', compiled_truth: 'srcb-only content\n' }, { sourceId: SRCB });
    const after = await engine.getStats({ sourceIds: [SRCA] });
    const afterHealth = await engine.getHealth({ sourceIds: [SRCA] });
    expect(after).toEqual(before);
    expect(afterHealth.page_count).toBe(beforeHealth.page_count);
    expect(afterHealth.entity_page_count).toBe(beforeHealth.entity_page_count);
    expect(afterHealth.brain_score).toBe(beforeHealth.brain_score);
    // And the excluded source is visible again the moment it is granted.
    const widened = await engine.getStats({ sourceIds: [SRCA, SRCB] });
    expect(widened.page_count).toBe(before.page_count + 2);
    // Restore the seed shape so later tests stay order-independent.
    await engine.executeRaw(
      `DELETE FROM pages WHERE slug = 'notes/hidden-growth' AND source_id = '${SRCB}'`,
    );
  });
}

describe('#4592 source-scoped stats/health (PGLite)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await seed(engine);
  }, 120_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  scopeAssertions(() => engine);

  // ── Op layer: the #4433 ladder ─────────────────────────────────────────
  const ctxBase = () =>
    ({
      engine,
      remote: true,
      transport: 'http',
      takesHoldersAllowList: ['world'],
    }) as unknown as OperationContext;

  test('remote scalar grant confines get_stats / get_health / get_brain_identity', async () => {
    const ctx = { ...ctxBase(), sourceId: SRCA } as OperationContext;
    const stats = (await operationsByName.get_stats.handler(ctx, {})) as { page_count: number };
    expect(stats.page_count).toBe(2);
    const health = (await operationsByName.get_health.handler(ctx, {})) as {
      page_count: number;
      migrations: unknown;
    };
    expect(health.page_count).toBe(2);
    // Global-by-decision: the host migration ledger has no per-source
    // semantics and stays visible to scoped callers.
    expect(health.migrations).toBeDefined();
    const ident = (await operationsByName.get_brain_identity.handler(ctx, {})) as {
      page_count: number;
    };
    expect(ident.page_count).toBe(2);
  });

  test('remote federated grant uses allowedSources; remote unscoped (__all__) fail-closes to zeros', async () => {
    const fed = {
      ...ctxBase(),
      sourceId: 'default',
      auth: { token: 't', clientId: 'c', scopes: ['read', 'admin'], allowedSources: [SRCA, SRCB] },
    } as OperationContext;
    const stats = (await operationsByName.get_stats.handler(fed, {})) as { page_count: number };
    // Compute the expectation from the engine so this test is independent of
    // whatever mutations earlier tests performed (order-independence).
    const expected = await engine.getStats({ sourceIds: [SRCA, SRCB] });
    expect(stats.page_count).toBe(expected.page_count);
    expect(stats.page_count).toBeGreaterThanOrEqual(3);

    const sentinel = { ...ctxBase(), sourceId: '__all__' } as OperationContext;
    const zeros = (await operationsByName.get_stats.handler(sentinel, {})) as { page_count: number };
    expect(zeros.page_count).toBe(0);
  });

  test('trusted local (remote === false) keeps the brain-wide view, sentinel included', async () => {
    const local = { ...ctxBase(), remote: false, sourceId: '__all__' } as OperationContext;
    const stats = (await operationsByName.get_stats.handler(local, {})) as { page_count: number };
    const brainWide = await engine.getStats();
    expect(stats.page_count).toBe(brainWide.page_count);
    expect(stats.page_count).toBeGreaterThanOrEqual(3);
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
describe.skipIf(!DATABASE_URL)('#4592 source-scoped stats/health (REAL Postgres parity)', () => {
  // Same seed, same engine-level assertions — the two engines' scope
  // predicates must agree (engine-parity iron rule).
  let engine: BrainEngine;

  beforeAll(async () => {
    const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
    const { assertSafeE2eDatabaseUrl } = await import('./helpers/db-guard.ts');
    assertSafeE2eDatabaseUrl(DATABASE_URL!);
    const pg = new PostgresEngine();
    await pg.connect({ database_url: DATABASE_URL! });
    await pg.initSchema();
    engine = pg;
    await engine.executeRaw(`DELETE FROM pages WHERE source_id IN ('${SRCA}', '${SRCB}')`);
    await seed(engine);
  }, 120_000);

  afterAll(async () => {
    // Guard: when beforeAll dies before assigning (e.g. a shard-neighbor
    // leaked a DATABASE_URL that flips the skipIf but fails the db-guard),
    // this hook still runs — a bare TypeError here buries the real error.
    if (!engine) return;
    await engine.executeRaw(`DELETE FROM pages WHERE source_id IN ('${SRCA}', '${SRCB}')`);
    await engine.executeRaw(`DELETE FROM sources WHERE id IN ('${SRCA}', '${SRCB}')`);
    await (engine as { disconnect(): Promise<void> }).disconnect();
  });

  scopeAssertions(() => engine);
});
