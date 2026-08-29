/**
 * D8 (test-gap plan; TODOS.md chennai-wave test debt item (b)) — getHealth
 * parity on real Postgres for the chennai wave's accounting fixes:
 *
 *   gbrain#4153 — the islanded (orphan_pages) predicate applies endpoint
 *   liveness in BOTH directions: an inbound link from a soft-deleted page
 *   and an outbound link to a soft-deleted target must NOT rescue a page
 *   from islanded status.
 *
 *   gbrain#4147 — entity-scoped link_coverage / timeline_coverage report
 *   null below MIN_ENTITY_PAGES_FOR_COVERAGE (0/0 must not read as a hard
 *   0%), with entity_page_count surfaced so consumers can tell 0% from
 *   vacuous.
 *
 * Unit coverage (test/health-islanded-liveness.test.ts) is PGLite-only.
 * This mirrors the same fixture shape onto BOTH engines — a fresh PGLite
 * instance and the live Postgres from helpers.setupDB — calls
 * engine.getHealth() on each, and asserts the headline fields agree:
 * entity_page_count matches, the null-coverage-below-floor arm reports
 * identically, and the islanded/liveness JOIN semantics agree on
 * orphan_pages.
 *
 * DATABASE_URL gated — skips gracefully when not set.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MIN_ENTITY_PAGES_FOR_COVERAGE } from '../../src/core/types.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const SKIP_PG = !hasDatabase();
const describeBoth = SKIP_PG ? describe.skip : describe;

async function link(engine: BrainEngine, fromSlug: string, toSlug: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO links (from_page_id, to_page_id, link_type)
     SELECT f.id, t.id, 'mentions'
       FROM pages f, pages t
      WHERE f.slug = $1 AND t.slug = $2`,
    [fromSlug, toSlug],
  );
}

async function softDelete(engine: BrainEngine, slug: string): Promise<void> {
  await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = $1`, [slug]);
}

/**
 * Same shape as the PGLite-only unit fixture, both arms at once:
 *
 * #4153 arm (islanded endpoint liveness, both directions):
 *   - live-target's ONLY inbound link comes from soft-deleted dead-source.
 *   - live-source's ONLY outbound link points at soft-deleted dead-target.
 *   Both must count as islanded. The linked live pair a<->b must not.
 *   Expected orphan_pages = 2 (dead pages are out of the page scope
 *   entirely; hub/people are rescued by live links).
 *
 * #4147 arm (small-N coverage floor):
 *   - MIN_ENTITY_PAGES_FOR_COVERAGE - 1 person pages, each linked from a
 *     live hub note, so entity_page_count sits ONE below the floor and both
 *     coverage ratios must be null (not 0, not 1) on both engines.
 */
async function seedFixture(engine: BrainEngine): Promise<void> {
  for (const [slug, type, title] of [
    ['live-target', 'note', 'T'],
    ['dead-source', 'note', 'S'],
    ['live-source', 'note', 'S2'],
    ['dead-target', 'note', 'T2'],
    ['a', 'note', 'A'],
    ['b', 'note', 'B'],
    ['hub', 'note', 'Hub'],
  ] as const) {
    await engine.putPage(slug, { type, title, compiled_truth: 'body', frontmatter: {} });
  }
  await link(engine, 'dead-source', 'live-target');
  await link(engine, 'live-source', 'dead-target');
  await link(engine, 'a', 'b');
  await softDelete(engine, 'dead-source');
  await softDelete(engine, 'dead-target');

  for (let i = 0; i < MIN_ENTITY_PAGES_FOR_COVERAGE - 1; i++) {
    await engine.putPage(`people/p${i}`, {
      type: 'person',
      title: `P${i}`,
      compiled_truth: 'bio',
      frontmatter: {},
    });
    await link(engine, 'hub', `people/p${i}`);
  }
}

describeBoth('getHealth parity — islanded liveness + entity-coverage floor (#4153/#4147)', () => {
  let pglite: PGLiteEngine;
  let postgres: BrainEngine;

  beforeAll(async () => {
    pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
    await seedFixture(pglite);

    postgres = await setupDB();
    await seedFixture(postgres);
  }, 120_000);

  afterAll(async () => {
    if (pglite) await pglite.disconnect();
    await teardownDB();
  });

  test('below the floor: entity_page_count matches and coverage is null on BOTH engines', async () => {
    const [pgliteH, postgresH] = [await pglite.getHealth(), await postgres.getHealth()];

    expect(postgresH.entity_page_count).toBe(MIN_ENTITY_PAGES_FOR_COVERAGE - 1);
    expect(pgliteH.entity_page_count).toBe(postgresH.entity_page_count);

    // #4147: below the small-N floor both ratios are null — a hard 0% (or a
    // noise 100%) on either engine is the regression this pins.
    expect(pgliteH.link_coverage).toBeNull();
    expect(postgresH.link_coverage).toBeNull();
    expect(pgliteH.timeline_coverage).toBeNull();
    expect(postgresH.timeline_coverage).toBeNull();
  });

  test('islanded endpoint liveness (#4153): orphan_pages identical, dead links do not rescue', async () => {
    const [pgliteH, postgresH] = [await pglite.getHealth(), await postgres.getHealth()];

    // live-target (dead inbound source) + live-source (dead outbound target).
    // a/b are rescued by their live link; hub/people by theirs.
    expect(postgresH.orphan_pages).toBe(2);
    expect(pgliteH.orphan_pages).toBe(postgresH.orphan_pages);

    // Adjacent scope fields the islanded JOINs feed: both engines must agree
    // on the live page scope and the policy-filtered linkable denominator.
    expect(pgliteH.page_count).toBe(postgresH.page_count);
    expect(pgliteH.linkable_page_count).toBe(postgresH.linkable_page_count);
    expect(pgliteH.dead_links).toBe(postgresH.dead_links);
  });

  test('at the floor: the real ratio is reported identically on BOTH engines', async () => {
    for (const engine of [pglite, postgres] as BrainEngine[]) {
      const i = MIN_ENTITY_PAGES_FOR_COVERAGE - 1;
      await engine.putPage(`people/p${i}`, {
        type: 'person',
        title: `P${i}`,
        compiled_truth: 'bio',
        frontmatter: {},
      });
      await link(engine, 'hub', `people/p${i}`);
    }

    const [pgliteH, postgresH] = [await pglite.getHealth(), await postgres.getHealth()];

    expect(postgresH.entity_page_count).toBe(MIN_ENTITY_PAGES_FOR_COVERAGE);
    expect(pgliteH.entity_page_count).toBe(postgresH.entity_page_count);
    // Every person page has a live inbound link from hub -> 100% link
    // coverage; nothing has timeline entries -> 0% timeline coverage. Real
    // numbers (not null) now that N is at the floor, and equal across engines.
    expect(pgliteH.link_coverage).toBe(1);
    expect(postgresH.link_coverage).toBe(1);
    expect(pgliteH.timeline_coverage).toBe(0);
    expect(postgresH.timeline_coverage).toBe(0);
  });
});
