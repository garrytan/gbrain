/**
 * #8729 Postgres arm of test/helpers/segmented-sync-replace-cases.ts (the PGLite arm is
 * test/large-pages/segmented-sync-replace-8729.test.ts): one isolated Postgres brain and a temporary GBRAIN_HOME around
 * the shared cases. Only Postgres pipelines a publication's calls, so only this arm can run a version's prune sweep
 * beside the flip. Shared by test/e2e/segmented-sync-replace-8729-postgres.test.ts and the typed preparation reads
 * guard, so no test file imports another.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { defineSegmentedSyncReplaceCases } from './segmented-sync-replace-cases.ts';
import { isolatedPersistencePostgres } from './persistence-postgres.ts';
import { withEnv } from './with-env.ts';
import { hasDatabase } from '../e2e/helpers.ts';

/** Registers the arm; it skips without DATABASE_URL. */
export function defineSegmentedSyncReplacePostgresArm(): void {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-replace-8729-pg-'));
  let engine: PostgresEngine;
  let close: (() => Promise<void>) | undefined;

  (hasDatabase() ? describe : describe.skip)('segmented sync replace (#8729) [postgres]', () => {
    beforeAll(async () => {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = pg.engine; close = pg.close;
    }, 120_000);
    afterAll(async () => {
      if (engine) await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine));
      await close?.();
      rmSync(home, { recursive: true, force: true });
    });
    defineSegmentedSyncReplaceCases({ getEngine: () => engine, home });
  });
}
