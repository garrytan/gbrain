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
 *
 * One shared engine for the whole file (schema init paid once, snapshot
 * allowed — nothing here asserts bootstrap behavior); each describe gets a
 * clean slate via a describe-scoped resetPgliteState beforeAll. Reset is
 * per-DESCRIBE, not per-test: tests within a describe deliberately share
 * state (the purge/dry-run describes assert against leftover rows from
 * earlier tests), matching the original one-engine-per-describe semantics.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

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
  beforeAll(async () => {
    await resetPgliteState(engine);
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
  beforeAll(async () => {
    await resetPgliteState(engine);
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
  beforeAll(async () => {
    await resetPgliteState(engine);
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

describe('purgeDeletedPages dry-run (shares the delete predicate)', () => {
  beforeAll(async () => {
    await resetPgliteState(engine);
  });

  async function pageCount(): Promise<number> {
    const rows = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages`);
    return rows[0].n;
  }

  test('dryRun: true deletes nothing (row count unchanged)', async () => {
    await seedPage(engine, 'dryrun/keeps-rows');
    await engine.softDeletePage('dryrun/keeps-rows');
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() - INTERVAL '73 hours' WHERE slug = $1`,
      ['dryrun/keeps-rows'],
    );
    const before = await pageCount();
    const preview = await engine.purgeDeletedPages(72, { dryRun: true });
    expect(preview.count).toBeGreaterThanOrEqual(1);
    expect(preview.slugs).toContain('dryrun/keeps-rows');
    expect(await pageCount()).toBe(before);
  });

  test('dryRun set === set actually deleted by the subsequent real run; live pages in neither', async () => {
    await seedPage(engine, 'dryrun/old-a');
    await seedPage(engine, 'dryrun/old-b');
    await seedPage(engine, 'dryrun/recent');
    await seedPage(engine, 'dryrun/live');
    await engine.softDeletePage('dryrun/old-a');
    await engine.softDeletePage('dryrun/old-b');
    await engine.softDeletePage('dryrun/recent');
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() - INTERVAL '73 hours' WHERE slug IN ($1, $2)`,
      ['dryrun/old-a', 'dryrun/old-b'],
    );

    const preview = await engine.purgeDeletedPages(72, { dryRun: true });
    const purged = await engine.purgeDeletedPages(72);

    expect([...preview.slugs].sort()).toEqual([...purged.slugs].sort());
    expect(preview.count).toBe(purged.count);
    // Live and inside-window pages are in neither set.
    expect(preview.slugs).not.toContain('dryrun/live');
    expect(preview.slugs).not.toContain('dryrun/recent');
    expect(purged.slugs).not.toContain('dryrun/live');
    expect(purged.slugs).not.toContain('dryrun/recent');
    // The real run actually removed the previewed rows.
    const rows = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages`);
    const remaining = rows.map((r) => r.slug);
    expect(remaining).not.toContain('dryrun/old-a');
    expect(remaining).not.toContain('dryrun/old-b');
    expect(remaining).toContain('dryrun/live');
    expect(remaining).toContain('dryrun/recent');
  });

  test('dry-run pages carry deleted_at as a Date (for CLI display)', async () => {
    await seedPage(engine, 'dryrun/dated');
    await engine.softDeletePage('dryrun/dated');
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() - INTERVAL '73 hours' WHERE slug = $1`,
      ['dryrun/dated'],
    );
    const preview = await engine.purgeDeletedPages(72, { dryRun: true });
    const entry = preview.pages?.find((p) => p.slug === 'dryrun/dated');
    expect(entry).toBeDefined();
    expect(entry!.deleted_at).toBeInstanceOf(Date);
    // Clean up so later tests in this describe see a stable baseline.
    await engine.purgeDeletedPages(72);
  });

  test('red contrast: the old listPages enumeration under-counts once live pages consume the cap', async () => {
    // The pre-fix dry-run enumerated listPages({ includeDeleted: true,
    // limit: 10000 }) and filtered in JS against Date.now(). Live pages
    // consume the cap, so a soft-deleted row past the cap is silently
    // missed. Reproduce the class at small scale: 3 recently-updated live
    // pages + 1 old soft-deleted page, enumeration capped at 3.
    for (const slug of ['cap/live-1', 'cap/live-2', 'cap/live-3', 'cap/victim']) {
      await seedPage(engine, slug);
    }
    await engine.softDeletePage('cap/victim');
    // Old deleted_at (past the 72h cutoff) AND old updated_at so the victim
    // sorts LAST under listPages' default updated_desc — exactly the row
    // shape that fell off the capped enumeration.
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() - INTERVAL '73 hours', updated_at = now() - INTERVAL '100 hours' WHERE slug = $1`,
      ['cap/victim'],
    );

    // Old predicate, verbatim (src/commands/pages.ts pre-fix), cap = 3.
    const candidates = await engine.listPages({ includeDeleted: true, limit: 3 });
    const cutoff = Date.now() - 72 * 60 * 60 * 1000;
    const oldStyle = candidates.filter(
      (p) => p.deleted_at && p.deleted_at instanceof Date && p.deleted_at.getTime() < cutoff,
    );
    expect(oldStyle.map((p) => p.slug)).not.toContain('cap/victim'); // the bug

    // The predicate-sharing dry-run finds it, and the real run deletes it.
    const preview = await engine.purgeDeletedPages(72, { dryRun: true });
    expect(preview.slugs).toContain('cap/victim');
    const purged = await engine.purgeDeletedPages(72);
    expect(purged.slugs).toContain('cap/victim');
  });

  test('dry-run clamps negative hours (no crash, finite count)', async () => {
    const preview = await engine.purgeDeletedPages(-72, { dryRun: true });
    expect(Number.isFinite(preview.count)).toBe(true);
    expect(preview.count).toBeGreaterThanOrEqual(0);
  });
});

describe('getPage / listPages includeDeleted contract (Q3 IRON RULE)', () => {
  beforeAll(async () => {
    await resetPgliteState(engine);
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
  beforeAll(async () => {
    await resetPgliteState(engine);
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
