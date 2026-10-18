/**
 * #6792/#6807 held-removal accept on a segmented page, PGLite arm (cases in
 * test/helpers/held-removal-segmented-cases.ts). Postgres arm:
 * test/e2e/held-removal-segmented-postgres.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { defineHeldRemovalSegmentedCases } from '../helpers/held-removal-segmented-cases.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-held-removal-segmented-'));
let engine: PGLiteEngine;

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}), 120_000);
afterAll(async () => {
  resetGateway();
  await disposePersistenceConsumer(engine); await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

describe('held-removal accept on a segmented page [pglite]', () => {
  defineHeldRemovalSegmentedCases({ getEngine: () => engine, home });
});
