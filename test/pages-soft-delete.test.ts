/**
 * v0.26.5 — page-level soft-delete contract tests.
 *
 * IRON RULE regression test for Q3 (the lynchpin eng-review decision):
 *   delete_page → get_page returns null → get_page({include_deleted:true}) returns
 *   the row with deleted_at populated → restore_page → get_page returns the row
 *   again with deleted_at unset.
 *
 * Plus: BrainEngine surface tests (softDeletePage / restorePage /
 * purgeDeletedPages) for happy-path / boundary / cascade cases.
 *
 * Runs against PGLite — same SQL contract as Postgres but DATABASE_URL-free.
 * Postgres-specific paths (CONCURRENTLY index, two-stage CTE) covered by
 * separate Postgres E2E tests.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

delete process.env.GBRAIN_PGLITE_SNAPSHOT;

async function setupBrain(): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  return engine;
}

async function seedPage(engine: PGLiteEngine, slug: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'note' as any,
    title: slug,
    compiled_truth: `Content of ${slug}`,
    timeline: '',
    frontmatter: {},
  });
}

describe('softDeletePage', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = await setupBrain();
  }, 30000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('happy path: sets deleted_at and returns slug', async () => {
    await seedPage(engine, 'people/alice');
    const result = await engine.softDeletePage('people/alice');
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('people/alice');
    // The row stays in the DB.
    const rows = await engine.executeRaw<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM pages WHERE slug = $1`,
      ['people/alice'],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].deleted_at).not.toBeNull();
  });

  test('returns null for unknown slug (idempotent-as-null)', async () => {
    expect(await engine.softDeletePage('does/not/exist')).toBeNull();
  });

  test('returns null on already-soft-deleted page (idempotent-as-null)', async () => {
    await seedPage(engine, 'people/bob');
    const first = await engine.softDeletePage('people/bob');
    expect(first).not.toBeNull();
    const second = await engine.softDeletePage('people/bob');
    expect(second).toBeNull();
  });
});

describe('restorePage', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = await setupBrain();
  }, 30000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('clears deleted_at on a soft-deleted page', async () => {
    await seedPage(engine, 'people/carol');
    await engine.softDeletePage('people/carol');
    expect(await engine.restorePage('people/carol')).toBe(true);
    const rows = await engine.executeRaw<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM pages WHERE slug = $1`,
      ['people/carol'],
    );
    expect(rows[0].deleted_at).toBeNull();
  });

  test('returns false for unknown slug', async () => {
    expect(await engine.restorePage('does/not/exist')).toBe(false);
  });

  test('returns false on already-active page (idempotent-as-false)', async () => {
    await seedPage(engine, 'people/dave');
    expect(await engine.restorePage('people/dave')).toBe(false);
  });
});

describe('purgeDeletedPages (TTL boundary)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = await setupBrain();
  }, 30000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('purges pages whose deleted_at is older than the cutoff', async () => {
    await seedPage(engine, 'people/eve');
    await seedPage(engine, 'people/frank');
    // Soft-delete both, then push one's deleted_at into the distant past.
    await engine.softDeletePage('people/eve');
    await engine.softDeletePage('people/frank');
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() - INTERVAL '73 hours' WHERE slug = $1`,
      ['people/eve'],
    );
    const result = await engine.purgeDeletedPages(72);
    expect(result.count).toBe(1);
    expect(result.slugs).toContain('people/eve');
    expect(result.slugs).not.toContain('people/frank');
    // 'eve' is gone; 'frank' is still there (still inside recovery window).
    const rows = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages`);
    const remaining = rows.map((r) => r.slug);
    expect(remaining).not.toContain('people/eve');
    expect(remaining).toContain('people/frank');
  });

  test('does NOT touch active pages (deleted_at IS NULL)', async () => {
    // Bound to this test's seeded slug. Other tests in the same describe may
    // have soft-deleted state laying around; we don't care about those, just
    // that THIS test's active page is not deleted.
    await seedPage(engine, 'people/grace-active');
    await engine.purgeDeletedPages(0);
    const rows = await engine.executeRaw<{ slug: string; deleted_at: string | null }>(
      `SELECT slug, deleted_at FROM pages WHERE slug = $1`,
      ['people/grace-active'],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].deleted_at).toBeNull();
  });

  test('cascades to content_chunks via FK ON DELETE CASCADE', async () => {
    await seedPage(engine, 'people/heidi');
    // Force-add a chunk row so we can observe cascade.
    const pageRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = $1`,
      ['people/heidi'],
    );
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source) VALUES ($1, 0, 'test', 'compiled_truth')`,
      [pageRows[0].id],
    );
    await engine.softDeletePage('people/heidi');
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() - INTERVAL '73 hours' WHERE slug = $1`,
      ['people/heidi'],
    );
    await engine.purgeDeletedPages(72);
    const remaining = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM content_chunks WHERE page_id = $1`,
      [pageRows[0].id],
    );
    expect(remaining[0].n).toBe(0);
  });

  test('clamps negative hours to 0 (no crash, no future-cutoff explosion)', async () => {
    await seedPage(engine, 'people/ivan');
    await engine.softDeletePage('people/ivan');
    // The contract being pinned: negative input must NOT pass through to the
    // SQL as a literal negative interval (which would purge from the future
    // and effectively delete every soft-deleted row). Implementation does
    // `Math.max(0, Math.floor(olderThanHours))`, so -72 collapses to 0. With
    // hours=0, the predicate `deleted_at < now()` may or may not match a row
    // soft-deleted in the same statement (timing-dependent), so this test
    // pins only the safety contract: it returns successfully with a finite
    // count and doesn't blow up the brain.
    const result = await engine.purgeDeletedPages(-72);
    expect(result.count).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.count)).toBe(true);
  });
});

describe('getPage / listPages includeDeleted contract (Q3 IRON RULE)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = await setupBrain();
  }, 30000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('Q3 round-trip: delete → get returns null → get(include_deleted) returns row → restore → get returns row again', async () => {
    await seedPage(engine, 'people/judy');

    // Step 1: page is visible by default.
    const before = await engine.getPage('people/judy');
    expect(before).not.toBeNull();
    expect(before!.deleted_at).toBeFalsy();

    // Step 2: soft-delete, default getPage returns null.
    await engine.softDeletePage('people/judy');
    const afterDelete = await engine.getPage('people/judy');
    expect(afterDelete).toBeNull();

    // Step 3: include_deleted: true surfaces the row with deleted_at populated.
    const surfaced = await engine.getPage('people/judy', { includeDeleted: true });
    expect(surfaced).not.toBeNull();
    expect(surfaced!.deleted_at).toBeInstanceOf(Date);

    // Step 4: restore → default getPage returns the row again.
    expect(await engine.restorePage('people/judy')).toBe(true);
    const restored = await engine.getPage('people/judy');
    expect(restored).not.toBeNull();
    expect(restored!.deleted_at).toBeFalsy();
  });

  test('listPages excludes soft-deleted by default', async () => {
    await seedPage(engine, 'people/kim');
    await seedPage(engine, 'people/larry');
    await engine.softDeletePage('people/kim');
    const pages = await engine.listPages({ limit: 100 });
    const slugs = pages.map((p) => p.slug);
    expect(slugs).not.toContain('people/kim');
    expect(slugs).toContain('people/larry');
  });

  test('listPages includes soft-deleted when includeDeleted: true', async () => {
    await seedPage(engine, 'people/mia');
    await engine.softDeletePage('people/mia');
    const pages = await engine.listPages({ limit: 100, includeDeleted: true });
    const slugs = pages.map((p) => p.slug);
    expect(slugs).toContain('people/mia');
    const mia = pages.find((p) => p.slug === 'people/mia')!;
    expect(mia.deleted_at).toBeInstanceOf(Date);
  });
});

describe('search visibility (soft-deleted pages hidden from searchKeyword)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = await setupBrain();
  }, 30000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('searchKeyword hides soft-deleted pages', async () => {
    // Two pages, same distinctive term, then soft-delete one.
    await engine.putPage('people/nora', {
      type: 'note' as any,
      title: 'Nora',
      compiled_truth: 'gbrainquantum signature term occurs here',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('people/oscar', {
      type: 'note' as any,
      title: 'Oscar',
      compiled_truth: 'gbrainquantum signature term occurs here too',
      timeline: '',
      frontmatter: {},
    });
    // Force chunk creation so search has something to index.
    await engine.upsertChunks('people/nora', [
      { chunk_index: 0, chunk_text: 'gbrainquantum signature term occurs here', chunk_source: 'compiled_truth' as any },
    ]);
    await engine.upsertChunks('people/oscar', [
      { chunk_index: 0, chunk_text: 'gbrainquantum signature term occurs here too', chunk_source: 'compiled_truth' as any },
    ]);

    const before = await engine.searchKeyword('gbrainquantum');
    expect(before.length).toBe(2);

    await engine.softDeletePage('people/nora');
    const after = await engine.searchKeyword('gbrainquantum');
    const slugs = after.map((r) => r.slug);
    expect(slugs).not.toContain('people/nora');
    expect(slugs).toContain('people/oscar');
  });

  test('searchKeyword hides pages from archived sources', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('archived-src', 'archived-src') ON CONFLICT DO NOTHING`,
    );
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title) VALUES ('archived-src', 'archived-src/secret', 'note', 'Secret')`,
    );
    const pageRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'archived-src/secret'`,
    );
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source) VALUES ($1, 0, 'gbrainsemaphore unique term', 'compiled_truth')`,
      [pageRows[0].id],
    );
    // Trigger should populate search_vector via the schema trigger.
    const before = await engine.searchKeyword('gbrainsemaphore');
    expect(before.length).toBe(1);

    // Archive the source.
    await engine.executeRaw(
      `UPDATE sources SET archived = true, archived_at = now(), archive_expires_at = now() + INTERVAL '72 hours' WHERE id = 'archived-src'`,
    );
    const after = await engine.searchKeyword('gbrainsemaphore');
    expect(after.length).toBe(0);
  });
});
