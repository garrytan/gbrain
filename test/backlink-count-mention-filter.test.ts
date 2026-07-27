/**
 * Regression test for D12: mentions filtered OUT of backlink-count.
 *
 * Codex outside-voice review on the v0.42.0.0 plan flagged that the
 * existing engine.getBacklinkCounts SQL had NO link_source filter — so
 * every link counts equally toward backlink-boost in hybridSearch.
 * Running `gbrain extract links --by-mention` would silently shift
 * search ranking globally on first run, boosting popular-mention pages
 * over intentional-backlink pages.
 *
 * D12 fix: filter `WHERE link_source IS DISTINCT FROM 'mentions'` so
 * mention-derived edges don't pollute ranking. Mentions still count
 * toward orphan-ratio (the whole point) and graph traversal.
 *
 * `IS DISTINCT FROM` is NULL-safe per the [sql-neq-misses-null-drift]
 * learning: NULL != 'mentions' would evaluate to NULL not TRUE in SQL
 * three-valued logic, silently dropping pre-v0.13 NULL-source rows from
 * backlink counts. The `IS DISTINCT FROM` form treats NULL as a
 * distinct value, so NULL rows count toward backlinks.
 *
 * Hermetic via PGLite. No DATABASE_URL needed.
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
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM pages');
});

async function seedTarget(slug: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'person', title: 'Target', compiled_truth: 'body', timeline: '', frontmatter: {},
  });
}

async function seedSource(slug: string, idx: number): Promise<void> {
  await engine.putPage(slug, {
    type: 'note', title: `Source ${idx}`, compiled_truth: 'body', timeline: '', frontmatter: {},
  });
}

describe('getBacklinkCounts — D12 mention filter', () => {
  test('10 markdown-source links + 0 mention-source → backlink count = 10', async () => {
    const target = 'people/alice';
    await seedTarget(target);
    const links = [];
    for (let i = 0; i < 10; i++) {
      const src = `writing/post-${i}`;
      await seedSource(src, i);
      links.push({
        from_slug: src,
        to_slug: target,
        link_type: 'mentions',
        link_source: 'markdown',
        context: '',
      });
    }
    await engine.addLinksBatch(links);
    const counts = await engine.getBacklinkCounts([target]);
    expect(counts.get(target)).toBe(10);
  });

  test('0 markdown + 50 mention-source links → backlink count = 0', async () => {
    const target = 'people/bob';
    await seedTarget(target);
    const links = [];
    for (let i = 0; i < 50; i++) {
      const src = `writing/mention-${i}`;
      await seedSource(src, i);
      links.push({
        from_slug: src,
        to_slug: target,
        link_type: 'mentions',
        link_source: 'mentions',
        context: '',
      });
    }
    await engine.addLinksBatch(links);
    const counts = await engine.getBacklinkCounts([target]);
    expect(counts.get(target)).toBe(0);
  });

  test('10 markdown + 50 mention-source → backlink count = 10', async () => {
    const target = 'people/carol';
    await seedTarget(target);
    const links = [];
    for (let i = 0; i < 10; i++) {
      const src = `writing/intent-${i}`;
      await seedSource(src, i);
      links.push({
        from_slug: src, to_slug: target, link_type: 'mentions', link_source: 'markdown', context: '',
      });
    }
    for (let i = 0; i < 50; i++) {
      const src = `writing/auto-${i}`;
      await seedSource(src, i + 100);
      links.push({
        from_slug: src, to_slug: target, link_type: 'mentions', link_source: 'mentions', context: '',
      });
    }
    await engine.addLinksBatch(links);
    const counts = await engine.getBacklinkCounts([target]);
    expect(counts.get(target)).toBe(10);
  });

  test('NULL link_source legacy rows still count toward backlinks (IS DISTINCT FROM semantics)', async () => {
    // Legacy pre-v0.13 rows have link_source = NULL. Per the
    // [sql-neq-misses-null-drift] learning, a naive `!= 'mentions'`
    // filter would silently drop these. `IS DISTINCT FROM` treats NULL
    // as a distinct value so NULL-source rows count.
    const target = 'people/legacy';
    await seedTarget(target);
    await seedSource('writing/legacy-1', 0);
    await seedSource('writing/legacy-2', 1);
    // Insert via raw SQL because addLinksBatch requires a link_source value
    // — legacy rows pre-v0.13 had NULL.
    const targetId = (await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = $1`, [target],
    ))[0]!.id;
    const src1Id = (await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = $1`, ['writing/legacy-1'],
    ))[0]!.id;
    const src2Id = (await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = $1`, ['writing/legacy-2'],
    ))[0]!.id;
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
       VALUES ($1, $2, $3, NULL), ($4, $2, $3, NULL)`,
      [src1Id, targetId, 'mentions', src2Id],
    );
    const counts = await engine.getBacklinkCounts([target]);
    expect(counts.get(target)).toBe(2);
  });

  test('mixed link_source (markdown, frontmatter, manual, NULL) all count; only mentions filtered', async () => {
    const target = 'companies/acme';
    await seedTarget(target);
    await seedSource('w/md', 1);
    await seedSource('w/fm', 2);
    await seedSource('w/manual', 3);
    await seedSource('w/auto', 4);
    // Insert via raw SQL since addLinksBatch doesn't accept all link_source variants in one call.
    const targetId = (await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = $1`, [target],
    ))[0]!.id;
    const ids = await engine.executeRaw<{ slug: string; id: number }>(
      `SELECT slug, id FROM pages WHERE slug IN ($1, $2, $3, $4)`,
      ['w/md', 'w/fm', 'w/manual', 'w/auto'],
    );
    const m = new Map(ids.map(r => [r.slug, r.id]));
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
       VALUES ($1, $5, 'mentions', 'markdown'),
              ($2, $5, 'mentions', 'frontmatter'),
              ($3, $5, 'mentions', 'manual'),
              ($4, $5, 'mentions', 'mentions')`,
      [m.get('w/md'), m.get('w/fm'), m.get('w/manual'), m.get('w/auto'), targetId],
    );
    const counts = await engine.getBacklinkCounts([target]);
    // markdown + frontmatter + manual = 3; mentions filtered out.
    expect(counts.get(target)).toBe(3);
  });

  test('uninitialized slug returns 0 (consistent map shape)', async () => {
    const counts = await engine.getBacklinkCounts(['does/not/exist']);
    expect(counts.get('does/not/exist')).toBe(0);
  });
});
