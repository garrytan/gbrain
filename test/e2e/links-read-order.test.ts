/**
 * getLinks / getBacklinks return rows in a stable order (link id) on both
 * engines.
 *
 * Authoring gate: the link reads had no ORDER BY, so rows came back in heap
 * order. Postgres MVCC writes an updated row as a new tuple at the end of
 * the heap, so re-upserting one edge (auto-link re-runs do) moved it behind
 * its siblings, and order-sensitive callers and tests flaked
 * (attendance-retrieval-postgres), and an index scan returns endpoint
 * page-id order instead. This test creates the endpoint pages in reverse,
 * rewrites the oldest edge and expects link-id order; without the ORDER BY
 * neither plan returns it.
 *
 * Postgres arm runs when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const backends = process.env.DATABASE_URL ? ['pglite', 'postgres'] as const : ['pglite'] as const;
const TARGETS = ['people/bea-example', 'people/cal-example', 'people/dee-example'];
const SOURCES = ['notes/one-example', 'notes/two-example', 'notes/three-example'];

for (const backend of backends) describe(`link reads keep link-id order (${backend})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;

  beforeAll(async () => {
    if (backend === 'postgres') {
      const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = isolated.engine;
      close = isolated.close;
    } else {
      const pglite = new PGLiteEngine();
      await pglite.connect({});
      await pglite.initSchema();
      engine = pglite;
      close = () => pglite.disconnect();
    }
    // Pages are created in reverse, so page-id order (what an index scan on the
    // endpoint columns yields) disagrees with link-id order.
    for (const slug of ['notes/hub-example', 'people/hub-example', ...[...TARGETS].reverse(), ...[...SOURCES].reverse()]) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body.`, timeline: '', frontmatter: {} });
    }
    for (const to of TARGETS) await engine.addLink('notes/hub-example', to, `mentions ${to}`, 'mentions', 'manual');
    for (const from of SOURCES) await engine.addLink(from, 'people/hub-example', `mentions hub from ${from}`, 'mentions', 'manual');
    // Rewrite the oldest edge of each set: MVCC moves its tuple to the end of the heap.
    await engine.executeRaw(`UPDATE links SET context = context || ' (edited)' WHERE id IN (
      SELECT MIN(l.id) FROM links l JOIN pages f ON f.id = l.from_page_id WHERE f.slug = 'notes/hub-example'
      UNION ALL
      SELECT MIN(l.id) FROM links l JOIN pages t ON t.id = l.to_page_id WHERE t.slug = 'people/hub-example')`);
  }, 120_000);

  afterAll(async () => { await close?.(); }, 60_000);

  test('getLinks returns outbound edges in link-id order after an edge is rewritten, in every scope arm', async () => {
    for (const opts of [undefined, { sourceId: 'default' }, { sourceIds: ['default'] }]) {
      const links = await engine.getLinks('notes/hub-example', opts);
      expect(links.map(l => l.to_slug), JSON.stringify(opts)).toEqual(TARGETS);
      expect(links[0].context).toEndWith('(edited)');
    }
  });

  test('getBacklinks returns inbound edges in link-id order after an edge is rewritten, in every scope arm', async () => {
    for (const opts of [undefined, { sourceId: 'default' }, { sourceIds: ['default'] }]) {
      const links = await engine.getBacklinks('people/hub-example', opts);
      expect(links.map(l => l.from_slug), JSON.stringify(opts)).toEqual(SOURCES);
      expect(links[0].context).toEndWith('(edited)');
    }
  });
});
