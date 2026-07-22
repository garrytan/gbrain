/**
 * E2E regression for #1178: 11 historical migrations (v14, v34, v38, v66, v71,
 * v91, v96, v97, v103, v104, v112) pre-drop an invalid CONCURRENTLY-build
 * remnant using `DO $$ BEGIN ... EXECUTE 'DROP INDEX CONCURRENTLY IF EXISTS
 * <name>'; END IF; END $$;`. Postgres rejects CONCURRENTLY from any
 * function/EXECUTE context, so the guard's EXISTS check passed but the
 * EXECUTE inside it always threw "DROP INDEX CONCURRENTLY cannot be executed
 * from a function" — each migration only failed on brains carrying an
 * invalid-index leftover from a prior interrupted CREATE INDEX CONCURRENTLY.
 *
 * The fix (introduced for the issue-reported migration, v66, in a prior PR)
 * replaces the DO block with dropInvalidConcurrentIndex(): the validity probe
 * runs as a plain application-level SELECT, and the DROP (when needed) runs
 * as its own top-level statement. This PR applies the same helper to the
 * remaining 10 historical sites the issue's own re-scan found — the
 * "recurrence" half of #1178 (5 new copies had shipped since the bug was
 * first reported, via copy-paste of the nearest similar migration).
 *
 * This test reproduces the issue's exact repro steps against real Postgres
 * for the two most structurally distinct sites (v66, already covered by the
 * prior PR, kept here for full-suite context; v112, a second independent
 * site) and confirms both migrations now recover instead of throwing.
 *
 * Real Postgres only — gated by DATABASE_URL, skips otherwise.
 *
 * Run: DATABASE_URL=... bun test test/e2e/migration-drop-invalid-concurrent-index.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getConn, getEngine, runMigrationsUpTo } from './helpers.ts';
import { MIGRATIONS, LATEST_VERSION } from '../../src/core/migrate.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping migration-drop-invalid-concurrent-index E2E tests (DATABASE_URL not set)');
}

async function isIndexValid(indexName: string): Promise<boolean | null> {
  const conn = getConn();
  const rows = await conn<Array<{ invalid: boolean }>>`
    SELECT NOT i.indisvalid AS invalid
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = ${indexName}
  `;
  if (rows.length === 0) return null; // does not exist
  return !rows[0].invalid;
}

/** OID of the index relation — used to prove a "no-op" run didn't silently drop+recreate (a recreated index gets a new OID under the same name). */
async function indexOid(indexName: string): Promise<string | null> {
  const conn = getConn();
  const rows = await conn<Array<{ oid: string }>>`SELECT to_regclass(${indexName})::oid::text AS oid`;
  return rows[0]?.oid ?? null;
}

/** Simulates a prior failed `CREATE INDEX CONCURRENTLY` per the issue's repro. */
async function plantInvalidIndex(indexName: string, createSQL: string): Promise<void> {
  const conn = getConn();
  await conn.unsafe(`DROP INDEX IF EXISTS ${indexName}`);
  await conn.unsafe(createSQL);
  await conn.unsafe(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${indexName}'::regclass`);
}

describeE2E('migration invalid-remnant recovery (#1178)', () => {
  beforeAll(async () => {
    await setupDB();
    await runMigrationsUpTo(getEngine(), LATEST_VERSION);
  }, 30_000);

  afterAll(async () => {
    await teardownDB();
  });

  test('v66 (idx_chunks_embedding_null, the issue-reported migration): invalid leftover no longer breaks the migration', async () => {
    await plantInvalidIndex(
      'idx_chunks_embedding_null',
      `CREATE INDEX idx_chunks_embedding_null ON content_chunks (page_id, chunk_index) WHERE embedding IS NULL`,
    );
    expect(await isIndexValid('idx_chunks_embedding_null')).toBe(false);

    const v66 = MIGRATIONS.find(m => m.version === 66);
    expect(v66?.handler).toBeDefined();

    // Pre-fix, this threw "DROP INDEX CONCURRENTLY cannot be executed from a function".
    await expect(v66!.handler!(getEngine())).resolves.toBeUndefined();

    expect(await isIndexValid('idx_chunks_embedding_null')).toBe(true);
  });

  test('re-running the migration when the index is already valid is a no-op (no spurious drop/recreate)', async () => {
    expect(await isIndexValid('idx_chunks_embedding_null')).toBe(true);
    const oidBefore = await indexOid('idx_chunks_embedding_null');
    expect(oidBefore).not.toBeNull();

    const v66 = MIGRATIONS.find(m => m.version === 66);
    await v66!.handler!(getEngine());

    expect(await isIndexValid('idx_chunks_embedding_null')).toBe(true);
    // Same OID proves the valid index survived untouched — validity alone
    // wouldn't catch a spurious drop+recreate (codex review, #1178).
    expect(await indexOid('idx_chunks_embedding_null')).toBe(oidBefore);
  });

  test('v112 (pages_links_extracted_at_idx, a second independent site from this batch): same recovery', async () => {
    await plantInvalidIndex(
      'pages_links_extracted_at_idx',
      `CREATE INDEX pages_links_extracted_at_idx ON pages (source_id, links_extracted_at)`,
    );
    expect(await isIndexValid('pages_links_extracted_at_idx')).toBe(false);

    const v112 = MIGRATIONS.find(m => m.version === 112);
    expect(v112?.handler).toBeDefined();

    await expect(v112!.handler!(getEngine())).resolves.toBeUndefined();

    expect(await isIndexValid('pages_links_extracted_at_idx')).toBe(true);
  });
});
