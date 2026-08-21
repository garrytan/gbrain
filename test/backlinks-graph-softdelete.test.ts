/**
 * `getBacklinks` / `traverseGraph` / `traversePaths` must filter soft-deleted
 * pages out of the `links` traversal — matching what `get`/`list`/`search`/
 * `orphans` already do.
 *
 * Before this fix, a soft-deleted page kept voting in the graph for its
 * entire retention window: `gbrain backlinks <target>` still listed a
 * referrer that had been soft-deleted, and `gbrain graph-query`/`gbrain
 * graph` still walked edges into (or out of) a soft-deleted page — directly
 * contradicting `gbrain orphans`, which already filters `deleted_at` on both
 * the candidate and the inbound-link source (`findOrphanPages`).
 *
 * This is the `page_links` traversal half of #3754. The doctor `graph_coverage`
 * check's own missing filter (a different surface: entity-page counting, not
 * edge traversal) was already fixed separately in #4165.
 *
 * Each engine method gets three cases: the SOURCE endpoint of a link
 * soft-deleted, the TARGET endpoint soft-deleted, and a healthy live-to-live
 * link (the control — proves the filter doesn't over-filter).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll() {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
}

async function seedThreeNodeChain() {
  // a -> b -> c, a simple chain so traversal has somewhere to go from each end.
  await engine.putPage('bl-a', { type: 'note', title: 'A', compiled_truth: '', timeline: '' });
  await engine.putPage('bl-b', { type: 'note', title: 'B', compiled_truth: '', timeline: '' });
  await engine.putPage('bl-c', { type: 'note', title: 'C', compiled_truth: '', timeline: '' });
  await engine.addLink('bl-a', 'bl-b', '', 'wikilink_basename');
  await engine.addLink('bl-b', 'bl-c', '', 'wikilink_basename');
}

describe('getBacklinks excludes links with a soft-deleted endpoint (#3754)', () => {
  beforeEach(async () => {
    await truncateAll();
    await seedThreeNodeChain();
  });

  test('control: healthy live-to-live link is still returned', async () => {
    const links = await engine.getBacklinks('bl-b');
    expect(links.map((l) => l.from_slug)).toEqual(['bl-a']);
  });

  test('source (referrer) soft-deleted -> excluded from backlinks of the target', async () => {
    await engine.softDeletePage('bl-a');
    const links = await engine.getBacklinks('bl-b');
    expect(links).toEqual([]);
  });

  test('target (queried page itself) soft-deleted -> excluded (matches get/list/orphans)', async () => {
    await engine.softDeletePage('bl-b');
    const links = await engine.getBacklinks('bl-b');
    expect(links).toEqual([]);
  });

  test('unrelated soft-deleted page does not affect a healthy link elsewhere', async () => {
    // bl-c is unrelated to the bl-a -> bl-b edge under test.
    await engine.softDeletePage('bl-c');
    const links = await engine.getBacklinks('bl-b');
    expect(links.map((l) => l.from_slug)).toEqual(['bl-a']);
  });
});

describe('traversePaths excludes edges touching a soft-deleted page (#3754)', () => {
  beforeEach(async () => {
    await truncateAll();
    await seedThreeNodeChain();
  });

  test('control: direction=out returns the healthy live-to-live edge', async () => {
    const paths = await engine.traversePaths('bl-a', { depth: 1, direction: 'out' });
    expect(paths.map((p) => `${p.from_slug}->${p.to_slug}`)).toEqual(['bl-a->bl-b']);
  });

  test('control: direction=in returns the healthy live-to-live edge', async () => {
    const paths = await engine.traversePaths('bl-b', { depth: 1, direction: 'in' });
    expect(paths.map((p) => `${p.from_slug}->${p.to_slug}`)).toEqual(['bl-a->bl-b']);
  });

  test('control: direction=both returns both healthy edges', async () => {
    const paths = await engine.traversePaths('bl-b', { depth: 1, direction: 'both' });
    const edges = paths.map((p) => `${p.from_slug}->${p.to_slug}`).sort();
    expect(edges).toEqual(['bl-a->bl-b', 'bl-b->bl-c']);
  });

  test('seed page soft-deleted -> empty traversal (direction=out)', async () => {
    await engine.softDeletePage('bl-a');
    const paths = await engine.traversePaths('bl-a', { depth: 1, direction: 'out' });
    expect(paths).toEqual([]);
  });

  test('seed page soft-deleted -> empty traversal (direction=in)', async () => {
    await engine.softDeletePage('bl-b');
    const paths = await engine.traversePaths('bl-b', { depth: 1, direction: 'in' });
    expect(paths).toEqual([]);
  });

  test('target neighbor soft-deleted -> edge excluded (direction=out)', async () => {
    await engine.softDeletePage('bl-b');
    // Traverse from bl-a; bl-b (the only neighbor) is soft-deleted.
    const paths = await engine.traversePaths('bl-a', { depth: 1, direction: 'out' });
    expect(paths).toEqual([]);
  });

  test('source neighbor soft-deleted -> edge excluded (direction=in)', async () => {
    await engine.softDeletePage('bl-a');
    // Traverse in-edges of bl-b; bl-a (the only referrer) is soft-deleted.
    const paths = await engine.traversePaths('bl-b', { depth: 1, direction: 'in' });
    expect(paths).toEqual([]);
  });

  test('direction=both drops only the edge touching the soft-deleted page', async () => {
    await engine.softDeletePage('bl-c');
    const paths = await engine.traversePaths('bl-b', { depth: 1, direction: 'both' });
    // bl-b -> bl-c is gone (bl-c deleted); bl-a -> bl-b survives.
    expect(paths.map((p) => `${p.from_slug}->${p.to_slug}`)).toEqual(['bl-a->bl-b']);
  });

  test('depth 2 traversal does not walk through a soft-deleted intermediate node', async () => {
    await engine.softDeletePage('bl-b');
    // a -> b -> c with b deleted: from a, depth 2 out should reach nothing
    // (the a->b edge itself is excluded, so c is unreachable through it).
    const paths = await engine.traversePaths('bl-a', { depth: 2, direction: 'out' });
    expect(paths).toEqual([]);
  });
});

describe('traverseGraph (legacy GraphNode[] shape) excludes soft-deleted pages (#3754)', () => {
  beforeEach(async () => {
    await truncateAll();
    await seedThreeNodeChain();
  });

  test('control: healthy chain traverses and reports outgoing edges', async () => {
    const nodes = await engine.traverseGraph('bl-a', 2);
    const slugs = nodes.map((n) => n.slug).sort();
    expect(slugs).toEqual(['bl-a', 'bl-b', 'bl-c']);
    const a = nodes.find((n) => n.slug === 'bl-a')!;
    expect(a.links.map((l) => l.to_slug)).toEqual(['bl-b']);
  });

  test('soft-deleted seed -> empty traversal', async () => {
    await engine.softDeletePage('bl-a');
    const nodes = await engine.traverseGraph('bl-a', 2);
    expect(nodes).toEqual([]);
  });

  test('soft-deleted neighbor is not walked to, and not listed in outgoing edges', async () => {
    await engine.softDeletePage('bl-b');
    const nodes = await engine.traverseGraph('bl-a', 2);
    const slugs = nodes.map((n) => n.slug);
    // bl-b itself must not appear as a visited node...
    expect(slugs).not.toContain('bl-b');
    // ...and bl-a's own displayed outgoing-edges list must not name it either
    // (the aggregation subquery is a separate query from the walk).
    const a = nodes.find((n) => n.slug === 'bl-a')!;
    expect(a.links.map((l) => l.to_slug)).not.toContain('bl-b');
  });
});
