/**
 * Foundations 2 (Lane C) bounded maintenance transactions at scale: on an
 * unmanaged brain with 10k pages, `gbrain extract timeline --source db`
 * commits one maintenanceTransaction per 100-row batch (never one transaction
 * for the run, so no 10k-row transaction holds locks), and every row names
 * the local maintenance principal. Rows of one transaction share
 * `last_written_at` (now() is the transaction start), so grouping by it
 * counts the transactions.
 *
 * Fails if the extraction stops chunking or writes outside
 * maintenanceTransaction. Runs on PGLite (`bun run test:slow`), and on
 * Postgres through test/e2e/write-attribution-timeline-10k-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { extractTimelineFromDB } from '../src/commands/extract-timeline-db.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { unmanagedBrain } from './helpers/unmanaged-attribution.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const quiet = { quiet: true, jsonMode: false, dryRun: false } as const;

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  resetGateway(); // R5: restore the preload baseline for later files in this shard
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
});

describe('bounded maintenance transactions at 10k pages', () => {
  test('extract timeline --source db commits 10k pages in bounded per-batch transactions', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      const pages = 10_000;
      await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
        SELECT $1, 'notes/bulk-' || g, 'note', 'Bulk ' || g, 'A bulk note.', '- **2026-01-01** | test — Bulk event ' || g, '{}'::jsonb
          FROM generate_series(1, $2::int) AS g`, [brain.sourceId, pages]);

      const result = await extractTimelineFromDB(engine, { sourceIdFilter: brain.sourceId, ...quiet });

      expect(result.created).toBe(pages);
      const [summary] = await engine.executeRaw<{ rows: number; attributed: number; transactions: number; largest: number }>(`
        SELECT sum(n)::int AS rows, sum(attributed)::int AS attributed, count(*)::int AS transactions, max(n)::int AS largest FROM (
          SELECT t.last_written_at, count(*) AS n,
                 count(*) FILTER (WHERE t.write_principal_kind=$2 AND t.write_principal_id=$3
                                    AND t.last_write_principal_kind=$2 AND t.last_write_principal_id=$3) AS attributed
            FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 GROUP BY t.last_written_at) per_transaction`,
      [brain.sourceId, brain.maintenance.kind, brain.maintenance.id]);
      expect(summary).toEqual({ rows: pages, attributed: pages, transactions: pages / 100, largest: 100 });
    }
  }, 600_000);
});
