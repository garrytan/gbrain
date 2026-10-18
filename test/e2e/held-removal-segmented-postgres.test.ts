/**
 * #6792/#6807 held-removal accept on a segmented page, Postgres arm (cases in
 * test/helpers/held-removal-segmented-cases.ts) on a fresh managed brain.
 * PGLite arm: test/large-pages/held-removal-segmented.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { defineHeldRemovalSegmentedCases } from '../helpers/held-removal-segmented-cases.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { hasDatabase } from './helpers.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-held-removal-segmented-pg-'));
let engine: PostgresEngine;
let close: (() => Promise<void>) | undefined;

(hasDatabase() ? describe : describe.skip)('held-removal accept on a segmented page [postgres]', () => {
  beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
    configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine; close = pg.close;
  }), 120_000);
  afterAll(async () => {
    resetGateway();
    if (engine) await disposePersistenceConsumer(engine);
    await close?.();
    rmSync(home, { recursive: true, force: true });
  });
  defineHeldRemovalSegmentedCases({ getEngine: () => engine, home });
});
