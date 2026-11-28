/**
 * The trunk's four schema migrations (v350 byte_order_slug_indexes, v351 projection_jobs_byte_order_index, v352
 * pages_projection_waiting_haystack_trgm, v353 fact_fingerprint_v3) sit above master's newest here, v343 (content_author_backfill,
 * #10545; master ddbcac0b4e added v338 oauth_refresh_rotations #10485, v339 facts_valid_from_nullable #10495, v340
 * engine_writer_observations_write_protocol #10501, v341 atom_scan_input_digest and v342 content_author_attribution #10545 above
 * v337), so a brain stamped at schema version 343 (a master brain) runs all four on upgrade, and one stamped at 342 runs v343 and
 * then the four. Brains at schema_version N never run a migration numbered at or below N, so a trunk migration numbered 343 or
 * lower would be skipped forever on such a brain. No released brain ran the trunk's earlier numbers (v336 to v341). They moved to
 * v350 to v353 in sync 20, above master's v338 (oauth_refresh_rotations, #10485), leaving room for master to land first.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a brain at version 343 applies exactly the migrations above it (the trunk ones: 350, 351, 352 and 353), builds
 *    the index migrations' indexes, and ends at the latest version; a second run applies nothing.
 *  - Regression: the trunk's migrations had taken master's numbers (334, then 336 and 337), so a master brain at that number
 *    skipped them.
 *  - Why existing coverage misses it: the migration-order check reads file names against origin/master, and the golden reads
 *    the registry; neither upgrades a stamped brain.
 *  - Seam: the real registry through `runMigrations` on a cold PGLite brain with the four indexes dropped and the version stamped.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';
import { MIGRATIONS } from '../src/core/schema-migrations/registry.generated.ts';

const MASTER_NEWEST = 343;
const TRUNK_INDEXES = ['idx_pages_source_slug_c', 'persistence_requests_source_slug_c', 'idx_page_projection_jobs_slug_c', 'idx_pages_projection_waiting_words'];

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

const present = async (): Promise<string[]> => (await engine.executeRaw<{ indexname: string }>(
  'SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[]) ORDER BY indexname', [TRUNK_INDEXES])).map(r => r.indexname);

describe('trunk migrations above master v343', () => {
  test('a brain stamped at 343, master newest, runs every trunk migration above it: the indexes appear and nothing is skipped', async () => {
    const trunk = MIGRATIONS.filter(m => ['byte_order_slug_indexes', 'projection_jobs_byte_order_index', 'pages_projection_waiting_haystack_trgm', 'fact_fingerprint_v3'].includes(m.name));
    expect(trunk.map(m => m.version)).toEqual([350, 351, 352, 353]);
    expect(Math.min(...trunk.map(m => m.version))).toBeGreaterThan(MASTER_NEWEST);
    // Every registered migration above master's newest (v343): the three index migrations and fact_fingerprint_v3.
    const above = MIGRATIONS.filter(m => m.version > MASTER_NEWEST).map(m => m.version).sort((a, b) => a - b);
    expect(above).toEqual([350, 351, 352, 353]);
    for (const index of TRUNK_INDEXES) await engine.executeRaw(`DROP INDEX IF EXISTS ${index}`);
    expect(await present()).toEqual([]);
    await engine.setConfig('version', String(MASTER_NEWEST));

    const first = await runMigrations(engine);
    expect(first.applied).toBe(above.length);
    expect(await present()).toEqual([...TRUNK_INDEXES].sort());
    expect(await engine.getConfig('version')).toBe(String(LATEST_SCHEMA_VERSION));
    expect((await runMigrations(engine)).applied).toBe(0);
  }, 120_000);

  test('a brain stamped at 342 runs v343 first and then the four trunk migrations, five in all', async () => {
    for (const index of TRUNK_INDEXES) await engine.executeRaw(`DROP INDEX IF EXISTS ${index}`);
    await engine.setConfig('version', '342');
    const run = await runMigrations(engine);
    expect(run.applied).toBe(5);
    expect(await present()).toEqual([...TRUNK_INDEXES].sort());
    expect(await engine.getConfig('version')).toBe(String(LATEST_SCHEMA_VERSION));
    expect((await runMigrations(engine)).applied).toBe(0);
  }, 120_000);
});
