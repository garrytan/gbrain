/**
 * E2E regression for #1178: migration v66 (`embed_stale_partial_index`)
 * pre-drops an invalid CONCURRENTLY-build remnant using
 * `DO $$ BEGIN ... EXECUTE 'DROP INDEX CONCURRENTLY IF EXISTS <name>'; END IF;
 * END $$;`. Postgres rejects CONCURRENTLY from any function/EXECUTE context,
 * so the guard's EXISTS check passed but the EXECUTE inside it always threw
 * "DROP INDEX CONCURRENTLY cannot be executed from a function" — the
 * migration only failed on brains carrying an invalid-index leftover from a
 * prior interrupted CREATE INDEX CONCURRENTLY.
 *
 * The fix replaces the DO block with dropInvalidConcurrentIndex(): the
 * validity probe runs as a plain application-level SELECT, and the DROP (when
 * needed) runs as its own top-level statement. This test reproduces the
 * issue's exact repro steps against real Postgres and confirms the migration
 * now recovers instead of throwing.
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

    const v66 = MIGRATIONS.find(m => m.version === 66);
    await v66!.handler!(getEngine());

    expect(await isIndexValid('idx_chunks_embedding_null')).toBe(true);
  });
});
