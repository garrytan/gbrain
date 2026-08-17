/**
 * gbrain#4153 + gbrain#4147 — getHealth accounting fixes.
 *
 * #4153: the islanded (orphan_pages) predicate must apply endpoint liveness
 * in BOTH directions — an inbound link from a soft-deleted page (the
 * invariant findOrphanPages documents) and an outbound link to a
 * soft-deleted target must NOT rescue a page from islanded status. Pre-fix,
 * get_health.orphan_pages disagreed with `gbrain orphans` whenever a
 * soft-deleted page still touched a live one.
 *
 * #4147: entity-scoped link_coverage / timeline_coverage report null below
 * MIN_ENTITY_PAGES_FOR_COVERAGE (0/0 used to read as a hard 0%), with
 * entity_page_count surfaced so consumers can tell 0% from vacuous.
 *
 * Red on master at the assertions: orphan_pages was 0 in both #4153 cases
 * (the dead link rescued the page), and coverage was 0 (not null) at N=0.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIN_ENTITY_PAGES_FOR_COVERAGE } from '../src/core/types.ts';

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
  for (const t of ['links', 'content_chunks', 'timeline_entries', 'raw_data', 'tags', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
});

async function pageId(slug: string): Promise<number> {
  return (await (engine as any).db.query(`SELECT id FROM pages WHERE slug=$1`, [slug])).rows[0].id;
}

async function link(fromSlug: string, toSlug: string): Promise<void> {
  await (engine as any).db.query(
    `INSERT INTO links (from_page_id, to_page_id, link_type) VALUES ($1, $2, 'mentions')`,
    [await pageId(fromSlug), await pageId(toSlug)],
  );
}

async function softDelete(slug: string): Promise<void> {
  await (engine as any).db.query(`UPDATE pages SET deleted_at = now() WHERE slug = $1`, [slug]);
}

describe('gbrain#4153 — islanded endpoint liveness (both directions)', () => {
  test('an inbound link from a soft-deleted page does NOT rescue a page from islanded', async () => {
    await engine.putPage('live-target', { type: 'note', title: 'T', compiled_truth: 'body', frontmatter: {} });
    await engine.putPage('dead-source', { type: 'note', title: 'S', compiled_truth: 'body', frontmatter: {} });
    await link('dead-source', 'live-target');
    await softDelete('dead-source');
    const h = await engine.getHealth();
    // live-target's only inbound link comes from a soft-deleted page — the
    // same situation `gbrain orphans` already reports as an orphan.
    expect(h.orphan_pages).toBe(1);
  });

  test('an outbound link to a soft-deleted target does NOT rescue a page from islanded', async () => {
    await engine.putPage('live-source', { type: 'note', title: 'S', compiled_truth: 'body', frontmatter: {} });
    await engine.putPage('dead-target', { type: 'note', title: 'T', compiled_truth: 'body', frontmatter: {} });
    await link('live-source', 'dead-target');
    await softDelete('dead-target');
    const h = await engine.getHealth();
    expect(h.orphan_pages).toBe(1);
  });

  test('live endpoints still rescue: linked live pages are not islanded', async () => {
    await engine.putPage('a', { type: 'note', title: 'A', compiled_truth: 'body', frontmatter: {} });
    await engine.putPage('b', { type: 'note', title: 'B', compiled_truth: 'body', frontmatter: {} });
    await link('a', 'b');
    const h = await engine.getHealth();
    expect(h.orphan_pages).toBe(0);
  });
});

describe('gbrain#4147 — entity coverage small-N guard', () => {
  async function seedEntities(n: number, linked: boolean): Promise<void> {
    for (let i = 0; i < n; i++) {
      await engine.putPage(`people/p${i}`, { type: 'person', title: `P${i}`, compiled_truth: 'bio', frontmatter: {} });
    }
    if (linked && n > 0) {
      await engine.putPage('hub', { type: 'note', title: 'Hub', compiled_truth: 'idx', frontmatter: {} });
      for (let i = 0; i < n; i++) await link('hub', `people/p${i}`);
    }
  }

  test('0 entity pages → coverage is null (not a hard 0%), entity_page_count 0', async () => {
    await engine.putPage('note/x', { type: 'note', title: 'X', compiled_truth: 'body', frontmatter: {} });
    const h = await engine.getHealth();
    expect(h.entity_page_count).toBe(0);
    expect(h.link_coverage).toBeNull();
    expect(h.timeline_coverage).toBeNull();
  });

  test('threshold-1 entity pages → still null (single-page 100% is noise too)', async () => {
    await seedEntities(MIN_ENTITY_PAGES_FOR_COVERAGE - 1, true);
    const h = await engine.getHealth();
    expect(h.entity_page_count).toBe(MIN_ENTITY_PAGES_FOR_COVERAGE - 1);
    expect(h.link_coverage).toBeNull();
    expect(h.timeline_coverage).toBeNull();
  });

  test('at the threshold → the real ratio is reported', async () => {
    await seedEntities(MIN_ENTITY_PAGES_FOR_COVERAGE, true);
    const h = await engine.getHealth();
    expect(h.entity_page_count).toBe(MIN_ENTITY_PAGES_FOR_COVERAGE);
    expect(h.link_coverage).toBe(1);
    expect(h.timeline_coverage).toBe(0); // no timeline entries seeded
  });
});
