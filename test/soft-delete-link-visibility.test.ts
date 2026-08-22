/**
 * #3754 — soft-deleted pages must not appear in backlinks / links / graph
 * traversal.
 *
 * Repro from the issue: bl-a links to bl-b; soft-delete bl-a. `get`, `list`,
 * `search`, and `orphans` already hide bl-a, but `backlinks bl-b` and
 * `graph-query bl-b --direction in` still returned it — the deleted_at filter
 * was missing wherever the links table is traversed. Both endpoints (f/t) now
 * carry `deleted_at IS NULL` in getLinks/getBacklinks, and traversePaths
 * filters at seed + step + final joins.
 *
 * PGLite-only here (always runs); Postgres parity is pinned in
 * test/e2e/engine-parity.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
});

async function seedPair() {
  await engine.putPage('bl-a', { type: 'note', title: 'bl-a', compiled_truth: 'links to bl-b', timeline: '' });
  await engine.putPage('bl-b', { type: 'note', title: 'bl-b', compiled_truth: 'target page', timeline: '' });
  await engine.addLink('bl-a', 'bl-b', 'This page links to [[bl-b]].', 'wikilink');
}

describe('#3754 getBacklinks hides soft-deleted endpoints', () => {
  test('soft-deleting the referrer removes it from backlinks (all three arms)', async () => {
    await seedPair();
    expect((await engine.getBacklinks('bl-b')).length).toBe(1);

    await engine.softDeletePage('bl-a', { sourceId: 'default' });

    // unscoped arm
    expect(await engine.getBacklinks('bl-b')).toEqual([]);
    // scalar sourceId arm
    expect(await engine.getBacklinks('bl-b', { sourceId: 'default' })).toEqual([]);
    // federated sourceIds arm
    expect(await engine.getBacklinks('bl-b', { sourceIds: ['default'] })).toEqual([]);
  });

  test('soft-deleting the target page removes the backlink row too', async () => {
    await seedPair();
    await engine.softDeletePage('bl-b', { sourceId: 'default' });
    expect(await engine.getBacklinks('bl-b')).toEqual([]);
    expect(await engine.getBacklinks('bl-b', { sourceId: 'default' })).toEqual([]);
  });

  test('restore brings the backlink back (edge row itself survives soft delete)', async () => {
    await seedPair();
    await engine.softDeletePage('bl-a', { sourceId: 'default' });
    expect(await engine.getBacklinks('bl-b')).toEqual([]);

    await engine.restorePage('bl-a', { sourceId: 'default' });
    const restored = await engine.getBacklinks('bl-b');
    expect(restored.length).toBe(1);
    expect(restored[0]!.from_slug).toBe('bl-a');
  });
});

describe('#3754 getLinks hides soft-deleted endpoints', () => {
  test('links to a soft-deleted target disappear (all three arms)', async () => {
    await seedPair();
    expect((await engine.getLinks('bl-a')).length).toBe(1);

    await engine.softDeletePage('bl-b', { sourceId: 'default' });

    expect(await engine.getLinks('bl-a')).toEqual([]);
    expect(await engine.getLinks('bl-a', { sourceId: 'default' })).toEqual([]);
    expect(await engine.getLinks('bl-a', { sourceIds: ['default'] })).toEqual([]);
  });

  test('links FROM a soft-deleted page disappear', async () => {
    await seedPair();
    await engine.softDeletePage('bl-a', { sourceId: 'default' });
    expect(await engine.getLinks('bl-a')).toEqual([]);
  });
});

describe('#3754 traversePaths hides soft-deleted pages', () => {
  test('direction=in: deleted referrer is not reachable', async () => {
    await seedPair();
    expect((await engine.traversePaths('bl-b', { direction: 'in' })).length).toBe(1);

    await engine.softDeletePage('bl-a', { sourceId: 'default' });
    expect(await engine.traversePaths('bl-b', { direction: 'in' })).toEqual([]);
  });

  test('direction=out: deleted target is not reachable', async () => {
    await seedPair();
    expect((await engine.traversePaths('bl-a', { direction: 'out' })).length).toBe(1);

    await engine.softDeletePage('bl-b', { sourceId: 'default' });
    expect(await engine.traversePaths('bl-a', { direction: 'out' })).toEqual([]);
  });

  test('direction=both: deleted neighbor is not reachable', async () => {
    await seedPair();
    expect((await engine.traversePaths('bl-b', { direction: 'both', depth: 1 })).length).toBe(1);

    await engine.softDeletePage('bl-a', { sourceId: 'default' });
    expect(await engine.traversePaths('bl-b', { direction: 'both', depth: 1 })).toEqual([]);
    expect(await engine.traversePaths('bl-b', { direction: 'both' })).toEqual([]);
  });

  test('a soft-deleted seed anchors nothing', async () => {
    await seedPair();
    await engine.softDeletePage('bl-a', { sourceId: 'default' });
    expect(await engine.traversePaths('bl-a', { direction: 'out' })).toEqual([]);
    expect(await engine.traversePaths('bl-a', { direction: 'both' })).toEqual([]);
  });

  test('a soft-deleted relay breaks multi-hop paths', async () => {
    // a -> mid -> c; delete mid; a must not reach c.
    await engine.putPage('hop-a', { type: 'note', title: 'a', compiled_truth: 'x', timeline: '' });
    await engine.putPage('hop-mid', { type: 'note', title: 'mid', compiled_truth: 'x', timeline: '' });
    await engine.putPage('hop-c', { type: 'note', title: 'c', compiled_truth: 'x', timeline: '' });
    await engine.addLink('hop-a', 'hop-mid', '', 'wikilink');
    await engine.addLink('hop-mid', 'hop-c', '', 'wikilink');
    expect((await engine.traversePaths('hop-a', { direction: 'out', depth: 3 })).length).toBe(2);

    await engine.softDeletePage('hop-mid', { sourceId: 'default' });
    expect(await engine.traversePaths('hop-a', { direction: 'out', depth: 3 })).toEqual([]);
  });
});

describe('#3754 traverseGraph hides soft-deleted pages', () => {
  test('deleted neighbor disappears from nodes AND from the displayed links array', async () => {
    await seedPair();
    const before = await engine.traverseGraph('bl-a', 1);
    expect(before.map((n) => n.slug).sort()).toEqual(['bl-a', 'bl-b']);

    await engine.softDeletePage('bl-b', { sourceId: 'default' });
    const after = await engine.traverseGraph('bl-a', 1);
    expect(after.map((n) => n.slug)).toEqual(['bl-a']);
    // The aggregation subquery must not display an edge to the deleted page.
    expect(after[0].links.map((l) => l.to_slug)).toEqual([]);
  });

  test('a soft-deleted seed anchors nothing', async () => {
    await seedPair();
    await engine.softDeletePage('bl-a', { sourceId: 'default' });
    expect(await engine.traverseGraph('bl-a', 1)).toEqual([]);
  });

  test('a soft-deleted relay breaks multi-hop traversal (recursive step filter)', async () => {
    await engine.putPage('tg-a', { type: 'note', title: 'a', compiled_truth: 'x', timeline: '' });
    await engine.putPage('tg-mid', { type: 'note', title: 'mid', compiled_truth: 'x', timeline: '' });
    await engine.putPage('tg-c', { type: 'note', title: 'c', compiled_truth: 'x', timeline: '' });
    await engine.addLink('tg-a', 'tg-mid', '', 'wikilink');
    await engine.addLink('tg-mid', 'tg-c', '', 'wikilink');
    expect((await engine.traverseGraph('tg-a', 3)).map((n) => n.slug).sort()).toEqual(['tg-a', 'tg-c', 'tg-mid']);

    await engine.softDeletePage('tg-mid', { sourceId: 'default' });
    expect((await engine.traverseGraph('tg-a', 3)).map((n) => n.slug)).toEqual(['tg-a']);
  });

  test('the frontier-capped recursive variant filters too', async () => {
    await seedPair();
    await engine.softDeletePage('bl-b', { sourceId: 'default' });
    const nodes = await engine.traverseGraph('bl-a', 1, { frontierCap: 10 });
    expect(nodes.map((n) => n.slug)).toEqual(['bl-a']);
  });

  test('restore brings the node back', async () => {
    await seedPair();
    await engine.softDeletePage('bl-b', { sourceId: 'default' });
    await engine.restorePage('bl-b', { sourceId: 'default' });
    const nodes = await engine.traverseGraph('bl-a', 1);
    expect(nodes.map((n) => n.slug).sort()).toEqual(['bl-a', 'bl-b']);
  });
});
