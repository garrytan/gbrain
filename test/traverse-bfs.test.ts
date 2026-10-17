/**
 * Breadth-first graph walks: each page once, at its shortest distance.
 *
 * On seeded random graphs (soft-deleted pages, three link types, cycles) the
 * engine walks must match a TypeScript BFS reference exactly, and the distinct
 * pages and edges they return must match the pre-BFS simple-path CTE, which
 * is kept here as the reference for the old contract. Only duplicate deeper
 * copies of a page or edge may differ from the old walk.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const PAGES = 60;
const LINKS = 220;
const TYPES = ['works_at', 'invested_in', 'mentions'];
const slugOf = (i: number) => `bfs/p${String(i).padStart(2, '0')}`;

let engine: PGLiteEngine;
const edges: Array<{ from: number; to: number; type: string }> = [];
const deleted = new Set<number>();

function rng(seed: number) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const rand = rng(7);
  for (let i = 0; i < PAGES; i++) {
    await engine.putPage(slugOf(i), { type: 'note', title: `p${i}`, compiled_truth: `page ${i}`, timeline: '' });
  }
  const seen = new Set<string>();
  while (edges.length < LINKS) {
    const from = Math.floor(rand() * PAGES);
    const to = Math.floor(Math.pow(rand(), 2) * PAGES);
    const type = TYPES[Math.floor(rand() * TYPES.length)];
    const key = `${from}|${to}|${type}`;
    if (from === to || seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, type });
  }
  await engine.addLinksBatch(edges.map(e => ({ from_slug: slugOf(e.from), to_slug: slugOf(e.to), link_type: e.type, link_source: 'manual' })));
  for (const i of [5, 17, 33]) {
    deleted.add(i);
    await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE slug = $1', [slugOf(i)]);
  }
}, 120_000);

afterAll(async () => { await engine.disconnect(); });

type Dir = 'out' | 'in' | 'both';

function live(e: { from: number; to: number }) {
  return !deleted.has(e.from) && !deleted.has(e.to);
}

function neighbours(w: number, dir: Dir, linkType?: string): number[] {
  const out: number[] = [];
  for (const e of edges) {
    if (!live(e) || (linkType && e.type !== linkType)) continue;
    if (dir !== 'in' && e.from === w) out.push(e.to);
    if (dir !== 'out' && e.to === w) out.push(e.from);
  }
  return out;
}

function distances(seed: number, maxLayer: number, dir: Dir, linkType?: string): Map<number, number> {
  const dist = new Map<number, number>([[seed, 0]]);
  let frontier = [seed];
  for (let d = 1; d <= maxLayer && frontier.length; d++) {
    const next: number[] = [];
    for (const w of frontier) for (const n of neighbours(w, dir, linkType)) {
      if (!dist.has(n)) { dist.set(n, d); next.push(n); }
    }
    frontier = next;
  }
  return dist;
}

function expectedPaths(seed: number, depth: number, dir: Dir, linkType?: string): string[] {
  const dist = distances(seed, depth - 1, dir, linkType);
  const out: string[] = [];
  for (const e of edges) {
    if (!live(e) || (linkType && e.type !== linkType)) continue;
    const sides = [dir !== 'in' ? dist.get(e.from) : undefined, dir !== 'out' ? dist.get(e.to) : undefined].filter((d): d is number => d !== undefined);
    if (sides.length) out.push(`${slugOf(e.from)}>${slugOf(e.to)}|${e.type}|${Math.min(...sides) + 1}`);
  }
  return out.sort();
}

const SEEDS = [0, 1, 2, 9, 41];

describe('breadth-first walks match a shortest-path reference', () => {
  test('traverseGraph returns each reachable page once at its shortest depth', async () => {
    let deepest = 0;
    for (const seed of SEEDS) for (const depth of [1, 2, 3, 5]) {
      const nodes = await engine.traverseGraph(slugOf(seed), depth);
      deepest = Math.max(deepest, ...nodes.map(n => n.depth));
      const got = nodes.map(n => `${n.slug}@${n.depth}`).sort();
      const want = [...distances(seed, depth, 'out')].map(([p, d]) => `${slugOf(p)}@${d}`).sort();
      expect(got).toEqual(want);
    }
    expect(deepest).toBeGreaterThanOrEqual(3);
  }, 60_000);

  test('traversePaths returns every qualifying edge once, one hop past its shallower walk-side page', async () => {
    let total = 0;
    for (const seed of SEEDS) for (const depth of [1, 2, 4]) for (const dir of ['out', 'in', 'both'] as Dir[]) for (const linkType of [undefined, 'works_at']) {
      const { paths, truncated } = await engine.traversePathsDetailed(slugOf(seed), { depth, direction: dir, linkType });
      total += paths.length;
      expect(truncated).toBe(false);
      const got = paths.map(p => `${p.from_slug}>${p.to_slug}|${p.link_type}|${p.depth}`).sort();
      expect(got).toEqual(expectedPaths(seed, depth, dir, linkType));
    }
    expect(total).toBeGreaterThan(1000);
  }, 120_000);
});

describe('distinct results are unchanged from the simple-path walk', () => {
  test('traverseGraph reaches the same pages as the pre-BFS CTE', async () => {
    for (const seed of SEEDS) for (const depth of [2, 3, 4]) {
      const old = await engine.executeRaw<{ slug: string }>(`
        WITH RECURSIVE graph AS (
          SELECT p.id, p.slug, 0 AS depth, ARRAY[p.id] AS visited FROM pages p WHERE p.slug = $1 AND p.deleted_at IS NULL
          UNION ALL
          SELECT p2.id, p2.slug, g.depth + 1, g.visited || p2.id
          FROM graph g JOIN links l ON l.from_page_id = g.id JOIN pages p2 ON p2.id = l.to_page_id
          WHERE g.depth < $2 AND NOT (p2.id = ANY(g.visited)) AND p2.deleted_at IS NULL)
        SELECT DISTINCT slug FROM graph ORDER BY slug`, [slugOf(seed), depth]);
      const nodes = await engine.traverseGraph(slugOf(seed), depth);
      expect([...new Set(nodes.map(n => n.slug))].sort()).toEqual(old.map(r => r.slug));
    }
  }, 60_000);
});

describe('a page the caller may not read never relays a walk', () => {
  test('private, out-of-scope and soft-deleted pages in the middle of a chain stop the walk', async () => {
    const { __resetPrivateVisibilityCacheForTests } = await import('../src/core/search/private-visibility.ts');
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('relay-b', 'relay-b', '{}'::jsonb) ON CONFLICT DO NOTHING`);
    for (const relay of ['private', 'foreign', 'deleted', 'origin']) {
      for (const hop of ['a', 'b', 'c']) {
        await engine.putPage(`relay/${relay}-${hop}`, {
          type: 'note', title: `${relay} ${hop}`, compiled_truth: hop, timeline: '',
          frontmatter: relay === 'private' && hop === 'b' ? { visibility: 'private' } : {},
        });
      }
      await engine.addLinksBatch([
        { from_slug: `relay/${relay}-a`, to_slug: `relay/${relay}-b`, link_type: 'works_at', link_source: 'manual' },
        { from_slug: `relay/${relay}-b`, to_slug: `relay/${relay}-c`, link_type: 'works_at', link_source: 'manual' },
      ]);
    }
    await engine.executeRaw(`UPDATE pages SET source_id = 'relay-b' WHERE slug = 'relay/foreign-b'`);
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'relay/deleted-b'`);
    await engine.executeRaw(`UPDATE pages SET frontmatter = '{"visibility":"private"}'::jsonb WHERE slug = 'relay/origin-c'`);
    await engine.executeRaw(`UPDATE links SET origin_page_id = (SELECT id FROM pages WHERE slug = 'relay/origin-c')
      WHERE from_page_id = (SELECT id FROM pages WHERE slug = 'relay/origin-a')`);
    __resetPrivateVisibilityCacheForTests();

    const reached = async (relay: string, opts: Record<string, unknown>) => {
      const nodes = await engine.traverseGraph(`relay/${relay}-a`, 3, opts);
      const paths = await engine.traversePaths(`relay/${relay}-a`, { depth: 3, direction: 'both', ...opts });
      return { nodes: nodes.map(n => n.slug).sort(), paths: paths.flatMap(p => [p.from_slug, p.to_slug]) };
    };
    for (const [relay, opts] of [['private', { excludePrivate: true }], ['foreign', { sourceId: 'default' }], ['deleted', {}], ['origin', { excludePrivate: true }]] as const) {
      const r = await reached(relay, opts);
      expect(r.nodes).toEqual([`relay/${relay}-a`]);
      expect(r.paths).not.toContain(`relay/${relay}-c`);
    }
    const open = await reached('private', {});
    expect(open.nodes).toEqual(['relay/private-a', 'relay/private-b', 'relay/private-c']);
  }, 60_000);
});
