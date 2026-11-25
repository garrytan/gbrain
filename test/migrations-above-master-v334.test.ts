/**
 * The trunk's schema migrations sit above master's v334 (learning_items, #10193) and PR 10168's reserved v335, so a brain
 * stamped at schema version 334 (a master brain) runs all of them on upgrade: the three index migrations (336, 337, 338) and
 * the segmented-write lane's fact_fingerprint_v3 (339). Brains at schema_version N never run a migration
 * numbered at or below N, so a trunk migration numbered 334 or lower would be skipped forever on such a brain.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a brain at version 334 applies exactly the migrations above it (336, 337, 338 and 339), builds the three index
 *    migrations' indexes, and ends at the latest version; a second run applies nothing.
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

const MASTER_V334 = 334;
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

describe('trunk migrations above master v334', () => {
  test('a brain stamped at 334 runs every trunk migration above it: the indexes appear and nothing is skipped', async () => {
    const trunk = MIGRATIONS.filter(m => ['byte_order_slug_indexes', 'projection_jobs_byte_order_index', 'pages_projection_waiting_haystack_trgm'].includes(m.name));
    expect(trunk.map(m => m.version)).toEqual([336, 337, 338]);
    expect(Math.min(...trunk.map(m => m.version))).toBeGreaterThan(MASTER_V334);
    // Every registered migration above master's v334: the three index migrations and fact_fingerprint_v3.
    const above = MIGRATIONS.filter(m => m.version > MASTER_V334).map(m => m.version).sort((a, b) => a - b);
    expect(above).toEqual([336, 337, 338, 339]);
    for (const index of TRUNK_INDEXES) await engine.executeRaw(`DROP INDEX IF EXISTS ${index}`);
    expect(await present()).toEqual([]);
    await engine.setConfig('version', String(MASTER_V334));

    const first = await runMigrations(engine);
    expect(first.applied).toBe(above.length);
    expect(await present()).toEqual([...TRUNK_INDEXES].sort());
    expect(await engine.getConfig('version')).toBe(String(LATEST_SCHEMA_VERSION));
    expect((await runMigrations(engine)).applied).toBe(0);
  }, 120_000);
});
