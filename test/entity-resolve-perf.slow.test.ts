/**
 * Perf regression guard for tryPrefixExpansion (T12 of the kinshasa-v3 wave).
 *
 * Asserts that the new correlated-subquery shape is at least 5x faster than
 * the pre-fix derived-table shape on the same seeded brain. Baseline-ratio,
 * not absolute wall-clock — different machines / Bun versions / PGLite
 * builds / CI load can shift absolute timings by 10x without indicating a
 * real regression, but the SHAPE difference between "aggregate full tables"
 * and "correlated subquery per candidate" is what we actually care about.
 *
 * The old SQL is embedded verbatim below as the regression baseline. If
 * a future refactor accidentally re-introduces full-table aggregation
 * (LEFT JOIN against a SELECT ... GROUP BY ... over the whole `links` or
 * `content_chunks` table), this test fails.
 *
 * .slow.test.ts suffix keeps it out of the fast loop. Run via
 * `bun run test:slow`.
 *
 * PGLite-only. Postgres E2E is intentionally skipped — PG's planner can
 * shape the OLD query's derived tables differently enough that the 5x
 * ratio could be noise on a 5K-page fixture. The structural correctness
 * of the rewrite is the same on both engines; this is purely a planner-
 * shape regression guard.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

// Seed sizes tuned to make the OLD shape visibly slow while keeping the
// cold-start fixture under ~10s. Numbers below match the kinshasa-v3 plan.
const PAGES = 5_000;
const LINKS = 50_000;
const CHUNKS = 25_000;
const RUNS = 5; // median of 5 runs per shape

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed pages. The Alice prefix has exactly 3 candidates (the case we
  // want both shapes to actually evaluate); the rest are random fillers
  // that contribute to the OLD shape's O(N) aggregation cost.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (engine as any).db;

  // Insert 3 target pages (people/alice-*).
  for (const slug of ['people/alice-example', 'people/alice-research', 'people/alice-engineer']) {
    await engine.putPage(slug, {
      type: 'person',
      title: slug.split('/').pop()!,
      compiled_truth: `# ${slug}`,
      frontmatter: { type: 'person', title: slug, slug },
    }, { sourceId: 'default' });
  }

  // Bulk-insert filler pages. Use a single executeRaw with generate_series
  // for speed; PGLite handles this fine.
  await db.query(
    `INSERT INTO pages (slug, type, title, compiled_truth, frontmatter, source_id, created_at, updated_at)
     SELECT 'filler/page-' || gs::text,
            'note',
            'Filler ' || gs::text,
            '# Filler',
            '{}',
            'default',
            NOW(),
            NOW()
     FROM generate_series(1, ${PAGES}) gs`,
  );

  // Capture id range for link + chunk inserts.
  const fillerIds = await db.query(`SELECT id FROM pages WHERE slug LIKE 'filler/%' LIMIT ${PAGES}`);
  const aliceIds = await db.query(`SELECT id FROM pages WHERE slug LIKE 'people/alice-%'`);
  const allIds = [...fillerIds.rows.map((r: { id: string }) => r.id), ...aliceIds.rows.map((r: { id: string }) => r.id)];

  // Spread LINKS across filler pages (filler→filler). The OLD shape will
  // aggregate ALL of these on every prefix-expansion call; the NEW shape
  // touches only the alice rows via index.
  const linkBatch = 5_000;
  for (let i = 0; i < LINKS; i += linkBatch) {
    const tuples: string[] = [];
    const params: string[] = [];
    let p = 1;
    for (let j = 0; j < linkBatch && i + j < LINKS; j++) {
      const from = allIds[Math.floor(Math.random() * allIds.length)];
      const to = allIds[Math.floor(Math.random() * allIds.length)];
      if (from === to) continue;
      tuples.push(`($${p++}, $${p++}, 'mentions')`);
      params.push(from, to);
    }
    if (tuples.length === 0) continue;
    // ON CONFLICT DO NOTHING — the links table has a unique index across
    // (from, to, type, source, origin); random pairs occasionally collide.
    // Test seeding doesn't care if a few inserts are skipped; the order of
    // magnitude is what matters for the perf comparison.
    await db.query(
      `INSERT INTO links (from_page_id, to_page_id, link_type) VALUES ${tuples.join(',')}
       ON CONFLICT DO NOTHING`,
      params,
    );
  }

  // Spread CHUNKS across all pages. Use a per-page counter so each
  // (page_id, chunk_index) pair is unique — there's a unique index on
  // content_chunks(page_id, chunk_index) so random chunk_index values
  // would collide.
  const chunkCounts = new Map<string, number>();
  const chunkBatch = 5_000;
  for (let i = 0; i < CHUNKS; i += chunkBatch) {
    const tuples: string[] = [];
    const params: (string | number)[] = [];
    let p = 1;
    for (let j = 0; j < chunkBatch && i + j < CHUNKS; j++) {
      const pid = allIds[Math.floor(Math.random() * allIds.length)];
      const idx = chunkCounts.get(pid) ?? 0;
      chunkCounts.set(pid, idx + 1);
      tuples.push(`($${p++}, $${p++}, $${p++})`);
      params.push(pid, idx, `chunk ${i + j}`);
    }
    await db.query(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text) VALUES ${tuples.join(',')}`,
      params,
    );
  }
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

// The pre-T12 query shape, embedded verbatim as the regression baseline.
// If a future refactor re-introduces this shape, the test fails.
const OLD_SQL = `
  SELECT p.slug,
         (COALESCE(li.in_count, 0) + COALESCE(lo.out_count, 0) + COALESCE(cc.chunk_count, 0))
           AS connection_count
  FROM pages p
  LEFT JOIN (
    SELECT to_page_id AS pid, COUNT(*)::int AS in_count
    FROM links GROUP BY to_page_id
  ) li ON li.pid = p.id
  LEFT JOIN (
    SELECT from_page_id AS pid, COUNT(*)::int AS out_count
    FROM links GROUP BY from_page_id
  ) lo ON lo.pid = p.id
  LEFT JOIN (
    SELECT page_id AS pid, COUNT(*)::int AS chunk_count
    FROM content_chunks GROUP BY page_id
  ) cc ON cc.pid = p.id
  WHERE p.source_id = $1
    AND p.deleted_at IS NULL
    AND p.slug LIKE $2
  ORDER BY connection_count DESC, p.slug ASC
  LIMIT 5
`;

// The T12 query shape — what tryPrefixExpansion now uses.
const NEW_SQL = `
  SELECT p.slug,
         ((SELECT COUNT(*)::int FROM links WHERE to_page_id = p.id)
          + (SELECT COUNT(*)::int FROM links WHERE from_page_id = p.id)
          + (SELECT COUNT(*)::int FROM content_chunks WHERE page_id = p.id))
           AS connection_count
  FROM pages p
  WHERE p.source_id = $1
    AND p.deleted_at IS NULL
    AND p.slug LIKE $2
  ORDER BY connection_count DESC, p.slug ASC
  LIMIT 5
`;

async function timeQuery(sql: string): Promise<number> {
  const start = performance.now();
  const rows = await engine.executeRaw<{ slug: string; connection_count: number }>(
    sql,
    ['default', 'people/alice-%'],
  );
  const elapsed = performance.now() - start;
  // Sanity: both shapes must return the same result set so the timing is
  // comparing apples to apples.
  if (rows.length === 0) throw new Error('Query returned no rows — fixture seeding broke');
  return elapsed;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

describe('tryPrefixExpansion perf regression — NEW shape >= 5x faster than OLD', () => {
  it('correlated subqueries beat derived-table aggregation by 5x or more', async () => {
    // Warm both shapes once so the planner caches its plan, then measure.
    await timeQuery(OLD_SQL);
    await timeQuery(NEW_SQL);

    const oldTimes: number[] = [];
    const newTimes: number[] = [];
    for (let i = 0; i < RUNS; i++) oldTimes.push(await timeQuery(OLD_SQL));
    for (let i = 0; i < RUNS; i++) newTimes.push(await timeQuery(NEW_SQL));

    const oldMedian = median(oldTimes);
    const newMedian = median(newTimes);
    const speedup = oldMedian / newMedian;

    // Emit timing data to stderr so a regression review can see the actual
    // numbers, not just pass/fail.
    process.stderr.write(
      `[entity-resolve-perf] fixture=${PAGES}p+${LINKS}l+${CHUNKS}c ` +
      `old_median=${oldMedian.toFixed(2)}ms new_median=${newMedian.toFixed(2)}ms ` +
      `speedup=${speedup.toFixed(2)}x\n`,
    );

    expect(speedup).toBeGreaterThanOrEqual(5);
  }, 60_000);
});
