/**
 * #8729 PGLite arm: test/helpers/segmented-sync-replace-cases.ts (the Postgres arm is
 * test/e2e/segmented-sync-replace-8729-postgres.test.ts).
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { defineSegmentedSyncReplaceCases } from '../helpers/segmented-sync-replace-cases.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-replace-8729-'));
let engine: PGLiteEngine;

describe('segmented sync replace (#8729) [pglite]', () => {
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
    rmSync(home, { recursive: true, force: true });
  });
  defineSegmentedSyncReplaceCases({ getEngine: () => engine, home });
});
