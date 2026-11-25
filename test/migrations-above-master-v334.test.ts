/**
 * The trunk's three schema migrations sit above master's newest, v335 (pages_spelling_key_index, #10168; v334 is learning_items,
 * #10193), so a brain stamped at schema version 335 (a master brain) runs all three on upgrade, and one stamped at 334 runs v335
 * and then the three. Brains at schema_version N never run a migration numbered at or below N, so a trunk migration numbered 335
 * or lower would be skipped forever on such a brain.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a brain at version 335 applies exactly the migrations above it (the three trunk ones: 336, 337, 338), builds
 *    their indexes, and ends at the latest version; a second run applies nothing.
 *  - Regression: the trunk's migrations had taken 334 to 336, colliding with master's v334, so a master v334 brain skipped them.
 *  - Why existing coverage misses it: the migration-order check reads file names against origin/master, and the golden reads
 *    the registry; neither upgrades a stamped brain.
 *  - Seam: the real registry through `runMigrations` on a cold PGLite brain with the four indexes dropped and the version stamped.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';
import { MIGRATIONS } from '../src/core/schema-migrations/registry.generated.ts';

const MASTER_NEWEST = 335;
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

describe('trunk migrations above master v335', () => {
  test('a brain stamped at 335, master newest, runs the three trunk migrations: their indexes appear and nothing is skipped', async () => {
    const trunk = MIGRATIONS.filter(m => ['byte_order_slug_indexes', 'projection_jobs_byte_order_index', 'pages_projection_waiting_haystack_trgm'].includes(m.name));
    expect(trunk.map(m => m.version)).toEqual([336, 337, 338]);
    expect(Math.min(...trunk.map(m => m.version))).toBeGreaterThan(MASTER_NEWEST);
    for (const index of TRUNK_INDEXES) await engine.executeRaw(`DROP INDEX IF EXISTS ${index}`);
    expect(await present()).toEqual([]);
    await engine.setConfig('version', String(MASTER_NEWEST));

    const first = await runMigrations(engine);
    expect(first.applied).toBe(3);
    expect(await present()).toEqual([...TRUNK_INDEXES].sort());
    expect(await engine.getConfig('version')).toBe(String(LATEST_SCHEMA_VERSION));
    expect((await runMigrations(engine)).applied).toBe(0);
  }, 120_000);

  test('a brain stamped at 334 runs v335 first and then the three trunk migrations, four in all', async () => {
    for (const index of TRUNK_INDEXES) await engine.executeRaw(`DROP INDEX IF EXISTS ${index}`);
    await engine.setConfig('version', '334');
    const run = await runMigrations(engine);
    expect(run.applied).toBe(4);
    expect(await present()).toEqual([...TRUNK_INDEXES].sort());
    expect(await engine.getConfig('version')).toBe(String(LATEST_SCHEMA_VERSION));
    expect((await runMigrations(engine)).applied).toBe(0);
  }, 120_000);
});
