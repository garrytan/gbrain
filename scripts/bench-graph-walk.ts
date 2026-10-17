/**
 * Graph walk benchmark: the breadth-first walks against the simple-path CTE
 * they replaced, on the graphs where the old walk was slow.
 *
 * Graphs (fictional, seeded):
 *   clique   12 pages, every page links to every other (the 22 s case)
 *   hub      test/helpers/dense-hub.ts: 400 spokes around one hub, ring of 12
 *   powerlaw 10,000 pages, 60,000 links, targets skewed toward hub pages
 *
 * For each graph, start page and depth it times `traverseGraph` and
 * `traversePathsDetailed` (out and both) through the engine, and the old
 * CTE's walk core (kept inline here, capped at the old 20,000-row
 * TRAVERSE_WALK_ROW_CAP), reporting median and p95 wall time over --runs runs.
 *
 * Usage: bun scripts/bench-graph-walk.ts [--runs 5] [--json]
 * Runs on PGLite. Set GBRAIN_BENCH_DATABASE_URL to a disposable test database
 * to run the same walks on Postgres (its pages and links tables are reset).
 */
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine, LinkBatchInput } from '../src/core/engine.ts';
import { seedDenseHub, DENSE_HUB_SLUG } from '../test/helpers/dense-hub.ts';

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf('--runs') + 1]) || 5;
const json = args.includes('--json');

const OLD_WALK = {
  out: `WITH RECURSIVE g AS (
      SELECT p.id, 0 AS depth, ARRAY[p.id] AS visited FROM pages p WHERE p.slug = $1 AND p.deleted_at IS NULL
      UNION ALL
      SELECT p2.id, g.depth + 1, g.visited || p2.id FROM g JOIN links l ON l.from_page_id = g.id JOIN pages p2 ON p2.id = l.to_page_id
      WHERE g.depth < $2 AND NOT (p2.id = ANY(g.visited)) AND p2.deleted_at IS NULL)
    SELECT count(*) FROM (SELECT DISTINCT id, depth FROM (SELECT id, depth FROM g LIMIT 20000) c) d`,
  both: `WITH RECURSIVE g AS (
      SELECT p.id, 0 AS depth, ARRAY[p.id] AS visited FROM pages p WHERE p.slug = $1 AND p.deleted_at IS NULL
      UNION ALL
      SELECT p2.id, g.depth + 1, g.visited || p2.id FROM g JOIN links l ON (l.from_page_id = g.id OR l.to_page_id = g.id)
      JOIN pages p2 ON p2.id = CASE WHEN l.from_page_id = g.id THEN l.to_page_id ELSE l.from_page_id END
      WHERE g.depth < $2 AND NOT (p2.id = ANY(g.visited)) AND p2.deleted_at IS NULL)
    SELECT count(*) FROM (SELECT DISTINCT id, depth FROM (SELECT id, depth FROM g LIMIT 20001) c) d`,
};

async function seed(engine: BrainEngine) {
  await seedDenseHub(engine);
  const put = async (slug: string) => engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, timeline: '' });
  const clique = (i: number) => `clique/n${String(i).padStart(2, '0')}`;
  for (let i = 0; i < 12; i++) await put(clique(i));
  const links: LinkBatchInput[] = [];
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) if (i !== j) links.push({ from_slug: clique(i), to_slug: clique(j), link_type: 'mentions', link_source: 'manual' });
  const pl = (i: number) => `pl/p${String(i).padStart(5, '0')}`;
  await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, frontmatter)
    SELECT 'pl/p' || lpad(g::text, 5, '0'), 'default', 'note', 'p' || g, '', '', '{}'::jsonb FROM generate_series(0, 9999) g`);
  let s = 42;
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  await engine.addLinksBatch(links); // gbrain-allow-direct-insert: benchmark fixture seeding a throwaway brain
  const seen = new Set<string>();
  const from: number[] = [];
  const to: number[] = [];
  while (seen.size < 60000) {
    const f = Math.floor(rand() * 10000);
    const t = Math.floor(Math.pow(rand(), 3) * 10000);
    if (f === t || seen.has(`${f}|${t}`)) continue;
    seen.add(`${f}|${t}`);
    from.push(f);
    to.push(t);
  }
  const ids = new Map((await engine.executeRaw<{ id: number; slug: string }>(`SELECT id, slug FROM pages WHERE slug LIKE 'pl/%'`)).map(r => [r.slug, Number(r.id)]));
  await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
    SELECT f, t, 'works_with', 'manual' FROM unnest($1::int[], $2::int[]) AS e(f, t)`,
    [from.map(i => ids.get(pl(i))), to.map(i => ids.get(pl(i)))]);
  console.error(`[bench] seeded ${links.length + from.length} links`);
  await engine.executeRaw('ANALYZE pages, links');
  return { clique: clique(0), hub: DENSE_HUB_SLUG, powerlaw_hub: pl(0), powerlaw_leaf: pl(7777) };
}

async function time(fn: () => Promise<unknown>) {
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  return { p50: ms[Math.floor(ms.length / 2)], p95: ms[Math.min(ms.length - 1, Math.ceil(ms.length * 0.95) - 1)] };
}

async function bench(name: string, engine: BrainEngine) {
  const starts = await seed(engine);
  const rows: Array<Record<string, unknown>> = [];
  for (const [graph, slug] of Object.entries(starts)) for (const depth of [1, 2, 3, 5]) {
    console.error(`[bench] ${name} ${graph} depth ${depth}`);
    const nodes = await time(() => engine.traverseGraph(slug, depth));
    const out = await time(() => engine.traversePathsDetailed(slug, { depth, direction: 'out' }));
    const both = await time(() => engine.traversePathsDetailed(slug, { depth, direction: 'both' }));
    const oldOut = await time(() => engine.executeRaw(OLD_WALK.out, [slug, depth]));
    const oldBoth = await time(() => engine.executeRaw(OLD_WALK.both, [slug, depth - 1]));
    rows.push({ engine: name, graph, depth, traverseGraph: nodes, pathsOut: out, pathsBoth: both, oldWalkOut: oldOut, oldWalkBoth: oldBoth });
  }
  return rows;
}

const fmt = (t: { p50: number; p95: number }) => `${t.p50.toFixed(1)} / ${t.p95.toFixed(1)}`;
const results: Array<Record<string, unknown>> = [];
const pglite = new PGLiteEngine();
await pglite.connect({});
await pglite.initSchema();
results.push(...await bench('pglite', pglite));
await pglite.disconnect();
const url = process.env.GBRAIN_BENCH_DATABASE_URL;
if (url) {
  const pg = new PostgresEngine();
  await pg.connect({ database_url: url });
  await pg.initSchema();
  await pg.executeRaw('TRUNCATE pages, links RESTART IDENTITY CASCADE');
  results.push(...await bench('postgres', pg));
  await pg.disconnect();
}
if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('median / p95 ms; old = the pre-BFS walk core alone, capped at 20,000 rows');
  console.log('| engine | graph | depth | traverseGraph | paths out | paths both | old walk out | old walk both |');
  console.log('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const r of results) {
    console.log(`| ${r.engine} | ${r.graph} | ${r.depth} | ${fmt(r.traverseGraph as never)} | ${fmt(r.pathsOut as never)} | ${fmt(r.pathsBoth as never)} | ${fmt(r.oldWalkOut as never)} | ${fmt(r.oldWalkBoth as never)} |`);
  }
}
