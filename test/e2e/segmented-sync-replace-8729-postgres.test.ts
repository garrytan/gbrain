/**
 * #8729 Postgres arm: test/helpers/segmented-sync-replace-cases.ts (the PGLite arm is
 * test/large-pages/segmented-sync-replace-8729.test.ts). Only Postgres pipelines a publication's calls, so only this arm
 * can run a version's prune sweep beside the flip.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { defineSegmentedSyncReplaceCases } from '../helpers/segmented-sync-replace-cases.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { hasDatabase } from './helpers.ts';

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
