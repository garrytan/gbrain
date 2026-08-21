/**
 * purgeDeletedPages dry-run parity, LIVE Postgres engine.
 *
 * Engine-parity counterpart of the PGLite coverage in
 * test/pages-soft-delete.test.ts ("purgeDeletedPages dry-run"): the dry-run
 * SELECT and the destructive DELETE share one WHERE predicate (same cutoff
 * arithmetic, same DB now() clock source), so absent concurrent writes the
 * previewed set equals the set a subsequent real run deletes (as here, where
 * the test is the only writer), and dry-run never mutates rows.
 *
 * Uses the canonical e2e harness (setupDB/teardownDB); gated by DATABASE_URL
 * via hasDatabase() and skips cleanly when unset, per the repo E2E lifecycle.
 *
 *   Run: DATABASE_URL=... bun test test/e2e/purge-deleted-dryrun-postgres.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

let engine: PostgresEngine;

async function insertPage(slug: string, deletedAtSql: string | null): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, deleted_at)
     VALUES ('default', $1, 'note', $1, ${deletedAtSql ?? 'NULL'})`,
    [slug],
  );
}

async function pageCount(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages`);
  return rows[0].n;
}

d('purgeDeletedPages dry-run parity (live Postgres)', () => {
  beforeAll(async () => {
    engine = await setupDB();
    await insertPage('purge-dryrun/old-a', `now() - INTERVAL '73 hours'`);
    await insertPage('purge-dryrun/old-b', `now() - INTERVAL '73 hours'`);
    await insertPage('purge-dryrun/recent', `now()`);
    await insertPage('purge-dryrun/live', null);
  }, 30000);

  afterAll(async () => {
    await teardownDB();
  });

  test('dry-run mutates nothing, previews exactly the set the real run deletes, and skips live rows', async () => {
    const before = await pageCount();

    const preview = await engine.purgeDeletedPages(72, { dryRun: true });
    expect(await pageCount()).toBe(before); // read-only
    expect([...preview.slugs].sort()).toEqual(['purge-dryrun/old-a', 'purge-dryrun/old-b']);
    expect(preview.count).toBe(2);
    // deleted_at is surfaced as a Date for CLI display.
    for (const p of preview.pages ?? []) expect(p.deleted_at).toBeInstanceOf(Date);
    expect(preview.pages?.length).toBe(2);

    const purged = await engine.purgeDeletedPages(72);
    expect([...purged.slugs].sort()).toEqual([...preview.slugs].sort());
    expect(purged.count).toBe(preview.count);

    // Live + inside-window rows survive the real run.
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE slug LIKE 'purge-dryrun/%'`,
    );
    const remaining = rows.map((r) => r.slug).sort();
    expect(remaining).toEqual(['purge-dryrun/live', 'purge-dryrun/recent']);
  });
});
