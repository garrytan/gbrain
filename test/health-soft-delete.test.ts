/**
 * #1305 — getHealth() must exclude soft-deleted pages from every
 * page-scoped count, the same posture getStats() has had since v0.26.5.
 *
 * Pre-fix, getHealth counted raw `pages` rows: page_count and orphan_pages
 * included soft-deleted pages, the entity_pages CTE kept deleted entities in
 * the link/timeline coverage denominators and in most_connected, and
 * brain_score therefore never moved when a user soft-deleted pages.
 *
 * Boundary (deliberate): chunk- and link-scoped counts (embed_coverage,
 * missing_embeddings, link_count, dead_links) stay RAW — they occupy storage
 * until the autopilot purge phase, matching getStats. Destructive-removal
 * counts (purge paths, #2235) also deliberately count all rows and are
 * untouched here.
 *
 * Runs against PGLite — the fixed SQL shapes are identical in both engines.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  for (const t of ['links', 'content_chunks', 'timeline_entries', 'tags', 'page_versions', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
});

async function seedNote(slug: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `content of ${slug}`, frontmatter: {} });
}

async function pageId(slug: string): Promise<number> {
  return (await (engine as any).db.query(`SELECT id FROM pages WHERE slug=$1`, [slug])).rows[0].id;
}

describe('#1305 — getHealth excludes soft-deleted pages', () => {
  test('page_count and orphan_pages match getStats after soft-delete (the issue repro)', async () => {
    for (let i = 0; i < 10; i++) await seedNote(`wiki/note-${i}`);
    for (let i = 0; i < 6; i++) await engine.softDeletePage(`wiki/note-${i}`);

    const stats = await engine.getStats();
    const health = await engine.getHealth();
    expect(stats.page_count).toBe(4);
    // Pre-fix: 10 (raw rows). getHealth must agree with getStats.
    expect(health.page_count).toBe(4);
    // Pre-fix: 10 — deleted pages stayed in the islanded scan.
    expect(health.orphan_pages).toBe(4);
  });

  test('brain_score moves when the user soft-deletes the islanded pages', async () => {
    // 2 connected pages + 8 islanded ones.
    await seedNote('wiki/hub');
    await seedNote('wiki/leaf');
    await (engine as any).db.query(
      `INSERT INTO links (from_page_id, to_page_id, link_type) VALUES ($1, $2, 'mentions')`,
      [await pageId('wiki/hub'), await pageId('wiki/leaf')],
    );
    for (let i = 0; i < 8; i++) await seedNote(`wiki/clutter-${i}`);

    const before = await engine.getHealth();
    for (let i = 0; i < 8; i++) await engine.softDeletePage(`wiki/clutter-${i}`);
    const after = await engine.getHealth();

    // Pre-fix both assertions fail: orphan_pages stayed 8 and brain_score
    // was byte-identical before/after the delete.
    expect(after.orphan_pages).toBe(0);
    expect(after.brain_score).toBeGreaterThan(before.brain_score);
  });

  test('entity coverage denominators and most_connected exclude deleted entities', async () => {
    // Live entity: inbound link + timeline entry → full coverage.
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice', compiled_truth: 'a person', frontmatter: {} });
    await engine.putPage('people/bob-example', { type: 'person', title: 'Bob', compiled_truth: 'another person', frontmatter: {} });
    await seedNote('wiki/mentions-alice');
    const aliceId = await pageId('people/alice-example');
    await (engine as any).db.query(
      `INSERT INTO links (from_page_id, to_page_id, link_type) VALUES ($1, $2, 'mentions')`,
      [await pageId('wiki/mentions-alice'), aliceId],
    );
    await (engine as any).db.query(
      `INSERT INTO timeline_entries (page_id, date, summary) VALUES ($1, '2026-01-01', 'met alice')`,
      [aliceId],
    );

    await engine.softDeletePage('people/bob-example');
    const h = await engine.getHealth();

    // Pre-fix: bob stayed in the entity_pages CTE → coverage 0.5 each,
    // and bob appeared in most_connected.
    expect(h.link_coverage).toBe(1);
    expect(h.timeline_coverage).toBe(1);
    expect(h.most_connected.map((c) => c.slug)).not.toContain('people/bob-example');
  });

  test('chunk storage counts stay raw (the deliberate boundary)', async () => {
    await seedNote('wiki/kept');
    await seedNote('wiki/gone');
    for (const slug of ['wiki/kept', 'wiki/gone']) {
      await (engine as any).db.query(
        `INSERT INTO content_chunks (page_id, chunk_index, chunk_text) VALUES ($1, 0, 'chunk')`,
        [await pageId(slug)],
      );
    }
    await engine.softDeletePage('wiki/gone');

    const h = await engine.getHealth();
    // Soft-deleted pages' chunks still occupy storage until purge; the
    // missing_embeddings count keeps seeing them, same as getStats.
    expect(h.missing_embeddings).toBe(2);
  });
});
