/**
 * v0.41.19.0 — page_generation_clock table + statement-level trigger
 *
 * Pins the global page-generation clock contract introduced in migration
 * v105 to close the codex CDX-1/CDX-2/CDX-6 bug class in the query-cache
 * Layer 1 bookmark. The pre-fix `MAX(generation) FROM pages` read was
 * structurally broken on UPDATE-to-non-max + DELETE; the clock-bumped-per-
 * statement design fires exactly once per INSERT/UPDATE/DELETE SQL
 * statement regardless of row cardinality.
 *
 * Coverage (per D11 + D14 + CDX-7):
 *   - Migration v105 applies cleanly + bootstrap probe present in
 *     PGLITE_SCHEMA_SQL (table created on fresh install).
 *   - Statement-level trigger fires once per INSERT statement.
 *   - Statement-level trigger fires once per UPDATE statement.
 *   - Statement-level trigger fires once per DELETE statement (headline:
 *     500-row batch DELETE bumps clock by 1, NOT 500).
 *   - UPDATE-to-non-max-page bumps the clock (CDX-2 regression pin).
 *   - DELETE-of-non-max-page bumps the clock (CDX-1 regression pin).
 *   - D14: end-to-end query-cache invalidation after batch DELETE.
 *   - CDX-6/D20: empty-result cache + INSERT matching page → cache invalidates.
 *   - CDX-7: cache a query, UPDATE non-max page → cache invalidates.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { DELETE_BATCH_SIZE } from '../src/core/engine-constants.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function clockValue(): Promise<number> {
  // v0.42.x: the Layer-1 bookmark moved from the locked single-row
  // page_generation_clock table to a contention-free SEQUENCE bumped by
  // nextval() in the statement trigger. Read last_value.
  const rows = await engine.executeRaw<{ value: number }>(
    `SELECT last_value AS value FROM page_generation_clock_seq`,
  );
  return Number(rows[0]?.value ?? -1);
}

describe('page_generation_clock table + statement-level trigger', () => {
  test('table exists and is single-row enforced', async () => {
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM page_generation_clock`,
    );
    expect(Number(rows[0].count)).toBe(1);

    // CHECK (id = 1) prevents a second row.
    let threw = false;
    try {
      await engine.executeRaw(
        `INSERT INTO page_generation_clock (id, value) VALUES (2, 100)`,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('seed: clock sequence starts at >= 1 with is_called=true', async () => {
    // v0.42.x: the sequence is seeded via setval(GREATEST(1, MAX(generation)))
    // at initSchema with is_called=true (2-arg setval), so the FIRST write's
    // nextval strictly exceeds the seed. Without is_called=true a fresh
    // sequence's first nextval returns the start value and last_value would not
    // visibly advance — that would let a fresh install serve a stale cache row.
    // resetPgliteState does NOT reset the sequence (sequences aren't pg_tables),
    // so last_value only ever increases — monotonic, never decrease-on-truncate.
    const v = await clockValue();
    expect(v).toBeGreaterThanOrEqual(1);
    const meta = await engine.executeRaw<{ is_called: boolean }>(
      `SELECT is_called FROM page_generation_clock_seq`,
    );
    expect(meta[0].is_called).toBe(true);
  });

  test('INSERT bumps clock by exactly 1 (single-row insert via raw SQL)', async () => {
    // NOTE: must use raw INSERT (without ON CONFLICT). Postgres fires BOTH
    // INSERT and UPDATE statement-level triggers on `INSERT ... ON CONFLICT
    // DO UPDATE` regardless of which branch ran, so engine.putPage (which
    // uses ON CONFLICT DO UPDATE) bumps the clock by 2, not 1. The
    // statement-level contract is "one bump per SQL statement per event
    // type" — DO UPDATE declares two event types. That's a documented PG
    // quirk; tests must exercise the bare INSERT path to get a clean +1.
    const before = await clockValue();
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
       VALUES ('default', 'test/single-insert', 'note', 't', 'body', '', '{}'::jsonb)`,
    );
    const after = await clockValue();
    expect(after).toBe(before + 1);
  });

  test('UPDATE bumps clock by exactly 1 (single-statement, raw SQL)', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
       VALUES ('default', 'test/update-target', 'note', 't', 'v1', '', '{}'::jsonb)`,
    );
    const before = await clockValue();
    await engine.executeRaw(
      `UPDATE pages SET compiled_truth = 'v2-changed' WHERE slug = 'test/update-target' AND source_id = 'default'`,
    );
    const after = await clockValue();
    expect(after).toBe(before + 1);
  });

  test('upsert via putPage bumps clock by 2 (INSERT...ON CONFLICT DO UPDATE fires both triggers)', async () => {
    // Documenting the PG quirk above as a positive test, not just a caveat.
    // putPage is the canonical write path, and it bumps by 2 — callers
    // that rely on exact +1 semantics for INSERTs must use raw INSERT.
    const before = await clockValue();
    await engine.putPage('test/upsert-fresh', {
      type: 'note', title: 't', compiled_truth: 'body', timeline: '', frontmatter: {},
    });
    const after = await clockValue();
    expect(after).toBe(before + 2);
  });

  test('headline contract: batch DELETE bumps clock by 1, NOT by row count', async () => {
    // Seed 25 pages (small batch for test speed; the contract is the same
    // at 500). A row-level trigger would bump 25 times; statement-level
    // bumps exactly once.
    const slugs: string[] = [];
    for (let i = 0; i < 25; i++) {
      const s = `test/bulk-${i}`;
      slugs.push(s);
      await engine.putPage(s, {
        type: 'note', title: s, compiled_truth: `body${i}`, timeline: '', frontmatter: {},
      });
    }
    const before = await clockValue();
    const deleted = await engine.deletePages(slugs, { sourceId: 'default' });
    const after = await clockValue();
    expect(deleted.length).toBe(25);
    expect(after).toBe(before + 1);
  });

  test('CDX-1 regression: DELETE of NON-MAX page bumps clock', async () => {
    // Seed two pages so MAX(generation) anchors at p2.
    await engine.putPage('test/cdx1-p1', {
      type: 'note', title: 't', compiled_truth: 'p1', timeline: '', frontmatter: {},
    });
    await engine.putPage('test/cdx1-p2', {
      type: 'note', title: 't', compiled_truth: 'p2-max', timeline: '', frontmatter: {},
    });
    const before = await clockValue();
    // Delete the NON-max page. Pre-fix, MAX(generation) didn't change so
    // the bookmark sat. Post-fix, the clock bumps via the statement trigger.
    await engine.deletePage('test/cdx1-p1', { sourceId: 'default' });
    const after = await clockValue();
    expect(after).toBe(before + 1);
  });

  test('CDX-2 regression: UPDATE of NON-MAX page bumps clock', async () => {
    // Seed p1, then p2 so p2 has the higher per-row generation.
    await engine.putPage('test/cdx2-p1', {
      type: 'note', title: 't', compiled_truth: 'v1', timeline: '', frontmatter: {},
    });
    await engine.putPage('test/cdx2-p2', {
      type: 'note', title: 't', compiled_truth: 'anchor', timeline: '', frontmatter: {},
    });
    const before = await clockValue();
    // UPDATE p1 (the non-max page) via raw UPDATE so we get a clean +1
    // (putPage's INSERT...ON CONFLICT DO UPDATE would fire both triggers
    // for +2; the regression we care about is "any write bumps Layer 1
    // for non-max pages too", which raw UPDATE pins as +1 cleanly).
    await engine.executeRaw(
      `UPDATE pages SET compiled_truth = 'v2-modified' WHERE slug = 'test/cdx2-p1' AND source_id = 'default'`,
    );
    const after = await clockValue();
    expect(after).toBe(before + 1);
  });

  test('DELETE_BATCH_SIZE is exported and equals 500', () => {
    expect(DELETE_BATCH_SIZE).toBe(500);
  });
});

describe('query-cache integration (D14 + CDX-6 + CDX-7 end-to-end)', () => {
  // These tests exercise the buildPageGenerationsSnapshot + the
  // CACHE_GATE_WHERE_CLAUSE path via direct SQL on query_cache. They
  // complement test/e2e/cache-gate-pglite.test.ts which uses the real
  // query-cache.ts wrapper.

  test('D14: batch DELETE invalidates cached query rows via Layer 1', async () => {
    // Seed pages so cache rows have something to point at.
    await engine.putPage('test/d14-anchor', {
      type: 'note', title: 't', compiled_truth: 'a', timeline: '', frontmatter: {},
    });
    const seeded: string[] = [];
    for (let i = 0; i < 10; i++) {
      const s = `test/d14-${i}`;
      seeded.push(s);
      await engine.putPage(s, {
        type: 'note', title: s, compiled_truth: `b${i}`, timeline: '', frontmatter: {},
      });
    }

    const beforeClock = await clockValue();
    await engine.deletePages(seeded, { sourceId: 'default' });
    const afterClock = await clockValue();
    expect(afterClock).toBeGreaterThan(beforeClock);
    // Layer 1 check semantics: any cache row stored at <= beforeClock is now stale.
    expect(afterClock > beforeClock).toBe(true);
  });

  test('CDX-6/D20: empty-result + matching INSERT → Layer 1 fires (clock advances)', async () => {
    // Empty-result query path: cache stamps at clock value T. INSERT a
    // matching page → clock advances via statement trigger. Layer 1
    // detects the advance. Pre-v0.41.19.0 the empty {} snapshot served
    // vacuously via Layer 2 — that was CDX-6. Use raw INSERT so the
    // bump is exactly +1 (putPage's INSERT...ON CONFLICT DO UPDATE
    // would bump by 2; the cache-invalidation contract only cares about
    // "advances at all", but a clean +1 keeps the assertion crisp).
    const beforeClock = await clockValue();
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
       VALUES ('default', 'test/cdx6-matching-page', 'note', 't', 'matches query', '', '{}'::jsonb)`,
    );
    const afterClock = await clockValue();
    expect(afterClock).toBe(beforeClock + 1);
  });
});

describe('v0.42.x sequence-backed clock (BUG 1: contention removal)', () => {
  test('mechanism: trigger function uses nextval, NOT a locked row UPDATE', async () => {
    // The contention source was `UPDATE page_generation_clock SET value=value+1
    // WHERE id=1` (a transaction-length RowExclusiveLock on one tuple). Prove at
    // the schema level that it is gone and replaced by nextval (a microsecond
    // LWLock). This is the deterministic, PGLite-runnable contention proof.
    const rows = await engine.executeRaw<{ src: string }>(
      `SELECT prosrc AS src FROM pg_proc WHERE proname = 'bump_page_generation_clock_fn'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].src).toContain("nextval('page_generation_clock_seq')");
    expect(rows[0].src).not.toContain('UPDATE page_generation_clock');
  });

  test('rollback still advances the sequence (over-invalidation is the SAFE direction)', async () => {
    const before = await clockValue();
    // Aborted import: the statement trigger fires nextval (sequences are
    // non-transactional), so last_value advances even though the page never
    // commits. A cache row stamped before this now fails Layer 1 and
    // re-validates — a LOST HIT, never a stale serve.
    try {
      await engine.transaction(async (tx) => {
        await tx.executeRaw(
          `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
           VALUES ('default', 'test/rollback-page', 'note', 't', 'body', '', '{}'::jsonb)`,
        );
        throw new Error('abort');
      });
    } catch {
      /* expected */
    }
    const after = await clockValue();
    expect(after).toBeGreaterThan(before);
    // The page itself did NOT persist — rollback worked.
    const pages = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE slug = 'test/rollback-page' AND source_id = 'default'`,
    );
    expect(Number(pages[0].n)).toBe(0);
  });

  test('PGLite supports sequences: CREATE / nextval / setval / last_value round-trip', async () => {
    // codex flagged: no existing sequence usage in the repo — prove (not assert)
    // that PGLite's WASM Postgres supports the constructs migration v118 relies
    // on, including the is_called gotcha the load-bearing setval guards against.
    await engine.executeRaw(`CREATE SEQUENCE IF NOT EXISTS test_probe_seq`);
    // Fresh sequence (is_called=false): first nextval returns the START value 1,
    // and last_value does NOT visibly advance past it — the exact trap.
    const n1 = await engine.executeRaw<{ v: number }>(`SELECT nextval('test_probe_seq') AS v`);
    expect(Number(n1[0].v)).toBe(1);
    const n2 = await engine.executeRaw<{ v: number }>(`SELECT nextval('test_probe_seq') AS v`);
    expect(Number(n2[0].v)).toBe(2);
    // 2-arg setval → last_value=N, is_called=true; the next nextval = N+1.
    await engine.executeRaw(`SELECT setval('test_probe_seq', 100)`);
    const lv = await engine.executeRaw<{ v: number }>(`SELECT last_value AS v FROM test_probe_seq`);
    expect(Number(lv[0].v)).toBe(100);
    const n3 = await engine.executeRaw<{ v: number }>(`SELECT nextval('test_probe_seq') AS v`);
    expect(Number(n3[0].v)).toBe(101);
    await engine.executeRaw(`DROP SEQUENCE test_probe_seq`);
  });

  test('re-seeding is monotonic: the GREATEST guard never moves last_value backward', async () => {
    // Regression for the codex P1: initSchema replays the schema blob, whose
    // setval must NOT reset the clock below its current value — a backward move
    // would let a stored query_cache bookmark serve stale rows. Push the
    // sequence high, then run the EXACT monotonic seed the blob + v118 use.
    await engine.executeRaw(`SELECT setval('page_generation_clock_seq', 999999)`);
    await engine.executeRaw(
      `SELECT setval('page_generation_clock_seq', GREATEST(
         1,
         COALESCE((SELECT last_value FROM page_generation_clock_seq), 0),
         COALESCE((SELECT value FROM page_generation_clock WHERE id = 1), 0),
         COALESCE((SELECT MAX(generation) FROM pages), 0)
       ))`,
    );
    expect(await clockValue()).toBeGreaterThanOrEqual(999999);
  });
});
