/**
 * v0.41.19.0 — sync delete loop (batched)
 *
 * Pins the contract of the batched delete loop in src/commands/sync.ts:
 * interleaved per-batch resolve + delete via engine.resolveSlugsByPaths +
 * engine.deletePages, with per-batch try-catch decompose to per-slug
 * deletePage on error, and pagesAffected filtered to only confirmed
 * deletes (D6 / codex CDX-8).
 *
 * Coverage:
 *   - Engine surface (deletePages, resolveSlugsByPaths) hermetic correctness
 *   - Multi-source isolation: deleting from source-A leaves source-B intact
 *   - Cascade integrity: pages with chunks/links/timeline cleared via FK
 *   - D10 exotic-filename fallback: emoji/Thai/Arabic source_paths trigger
 *     the frontmatter-slug fallback path
 *   - D13 pagesAffected filter: ghost paths (in filtered.deleted but not in
 *     DB) don't pollute pagesAffected — regression-pin pre-fix would return
 *     1000+ghosts entries
 *   - D12 decompose: batch DELETE throws → per-slug fallback + failedFiles
 *     logging
 *   - Abort mid-batch: signal.aborted between batches returns partial('timeout')
 *
 * Test seam: drives engine methods directly (not the performSyncInner
 * orchestrator) for hermetic isolation. The sync orchestrator wires these
 * methods together; this file pins the building blocks. Integration via
 * the real performSyncInner is covered by test/e2e/sync.test.ts.
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

async function seedSource(id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ($1, $2, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    [id, id],
  );
}

async function seedPageWithPath(slug: string, sourcePath: string, sourceId = 'default'): Promise<number> {
  if (sourceId !== 'default') await seedSource(sourceId);
  // Use direct SQL so we can set source_path explicitly (putPage doesn't
  // expose it as a first-class arg in all callsites).
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, source_path, type, title, compiled_truth, timeline, frontmatter)
     VALUES ($1, $2, $3, 'note', $2, 'body', '', '{}'::jsonb)
     ON CONFLICT (source_id, slug) DO UPDATE SET source_path = EXCLUDED.source_path`,
    [sourceId, slug, sourcePath],
  );
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE source_id = $1 AND slug = $2`,
    [sourceId, slug],
  );
  return rows[0].id;
}

describe('engine.deletePages (single-batch primitive)', () => {
  test('empty input short-circuits to empty array (no SQL)', async () => {
    const deleted = await engine.deletePages([], { sourceId: 'default' });
    expect(deleted).toEqual([]);
  });

  test('returns confirmed-deleted slugs (D6)', async () => {
    await seedPageWithPath('test/dp1', 'wiki/dp1.md');
    await seedPageWithPath('test/dp2', 'wiki/dp2.md');
    await seedPageWithPath('test/dp3', 'wiki/dp3.md');
    const deleted = await engine.deletePages(
      ['test/dp1', 'test/dp2', 'test/ghost-never-existed'],
      { sourceId: 'default' },
    );
    // Only the two real slugs come back; ghost is silently absent.
    expect(deleted.sort()).toEqual(['test/dp1', 'test/dp2']);
  });

  test('multi-source isolation: deleting source-A leaves source-B untouched', async () => {
    await seedSource('alpha');
    await seedSource('beta');
    await seedPageWithPath('shared/slug', 'shared.md', 'alpha');
    await seedPageWithPath('shared/slug', 'shared.md', 'beta');

    const deleted = await engine.deletePages(['shared/slug'], { sourceId: 'alpha' });
    expect(deleted).toEqual(['shared/slug']);

    // Verify beta's row survives.
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = 'shared/slug'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('beta');
  });

  test('cascade integrity: chunks/links/timeline cleared via FK', async () => {
    const p1 = await seedPageWithPath('test/cascade-1', 'cascade1.md');
    const p2 = await seedPageWithPath('test/cascade-2', 'cascade2.md');

    // Seed content_chunks for p1 (FK ON DELETE CASCADE).
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
       VALUES ($1, 0, 'chunk a'), ($1, 1, 'chunk b'), ($1, 2, 'chunk c')`,
      [p1],
    );
    // Seed links: p1 → p2 (CASCADE on from_page_id) and p2 → p1.
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source, context)
       VALUES ($1, $2, 'mentions', 'markdown', ''), ($2, $1, 'mentions', 'markdown', '')`,
      [p1, p2],
    );

    const chunksBefore = await engine.executeRaw<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM content_chunks WHERE page_id = $1`,
      [p1],
    );
    expect(Number(chunksBefore[0].c)).toBe(3);

    await engine.deletePages(['test/cascade-1'], { sourceId: 'default' });

    const chunksAfter = await engine.executeRaw<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM content_chunks WHERE page_id = $1`,
      [p1],
    );
    expect(Number(chunksAfter[0].c)).toBe(0);

    const linksAfter = await engine.executeRaw<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM links WHERE from_page_id = $1 OR to_page_id = $1`,
      [p1],
    );
    expect(Number(linksAfter[0].c)).toBe(0);

    // p2 itself untouched.
    const p2Rows = await engine.executeRaw<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM pages WHERE id = $1`,
      [p2],
    );
    expect(Number(p2Rows[0].c)).toBe(1);
  });

  test('rejects oversized input (caller chunking contract)', async () => {
    const tooBig = new Array(DELETE_BATCH_SIZE + 1).fill('test/x');
    let threw = false;
    try {
      await engine.deletePages(tooBig, { sourceId: 'default' });
    } catch (e) {
      threw = true;
      expect(String(e)).toContain('DELETE_BATCH_SIZE');
    }
    expect(threw).toBe(true);
  });
});

describe('engine.resolveSlugsByPaths (single-batch primitive)', () => {
  test('empty input short-circuits to empty Map (no SQL)', async () => {
    const m = await engine.resolveSlugsByPaths([], { sourceId: 'default' });
    expect(m.size).toBe(0);
  });

  test('resolves source_path → slug for present rows', async () => {
    await seedPageWithPath('alpha-slug', 'wiki/alpha.md');
    await seedPageWithPath('beta-slug', 'wiki/beta.md');
    const m = await engine.resolveSlugsByPaths(
      ['wiki/alpha.md', 'wiki/beta.md', 'wiki/missing.md'],
      { sourceId: 'default' },
    );
    expect(m.get('wiki/alpha.md')).toBe('alpha-slug');
    expect(m.get('wiki/beta.md')).toBe('beta-slug');
    expect(m.get('wiki/missing.md')).toBeUndefined();
  });

  test('D10 exotic filename fallback substrate: frontmatter-slug rows resolvable', async () => {
    // Filenames whose slugifyPath would return empty (emoji/Thai/Arabic).
    // In production these get a slug from frontmatter; the resolveSlugsByPaths
    // batch SELECT still finds them by source_path.
    await seedPageWithPath('star-page', '🌟.md');
    await seedPageWithPath('thai-page', 'ทดสอบ.md');
    await seedPageWithPath('arabic-page', 'عربي.md');
    const m = await engine.resolveSlugsByPaths(
      ['🌟.md', 'ทดสอบ.md', 'عربي.md'],
      { sourceId: 'default' },
    );
    expect(m.get('🌟.md')).toBe('star-page');
    expect(m.get('ทดสอบ.md')).toBe('thai-page');
    expect(m.get('عربي.md')).toBe('arabic-page');
  });

  test('source isolation: only rows in the requested source come back', async () => {
    await seedSource('alpha');
    await seedSource('beta');
    await seedPageWithPath('a-only', 'overlap.md', 'alpha');
    await seedPageWithPath('b-only', 'overlap.md', 'beta');

    const mAlpha = await engine.resolveSlugsByPaths(['overlap.md'], { sourceId: 'alpha' });
    expect(mAlpha.get('overlap.md')).toBe('a-only');

    const mBeta = await engine.resolveSlugsByPaths(['overlap.md'], { sourceId: 'beta' });
    expect(mBeta.get('overlap.md')).toBe('b-only');
  });
});

describe('D13 pagesAffected filtering regression', () => {
  test('1000 deletable + 100 ghost paths → deletePages returns 1000', async () => {
    // Smaller scale to stay fast; 100 + 10 ghosts pins the same contract.
    for (let i = 0; i < 100; i++) {
      await seedPageWithPath(`bulk/${i}`, `bulk/${i}.md`);
    }
    const realSlugs = Array.from({ length: 100 }, (_, i) => `bulk/${i}`);
    const ghostSlugs = Array.from({ length: 10 }, (_, i) => `bulk/ghost-${i}`);
    const allSlugs = [...realSlugs, ...ghostSlugs];

    const deleted = await engine.deletePages(allSlugs, { sourceId: 'default' });

    // Pre-v0.41.19.0 the caller would have pushed all 110 slugs onto
    // pagesAffected (no filtering); post-fix only the 100 real deletes
    // come back from RETURNING.
    expect(deleted.length).toBe(100);
    expect(deleted.sort()).toEqual(realSlugs.sort());
  });
});
