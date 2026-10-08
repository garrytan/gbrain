/**
 * #6278 (v220): `persistence_requests.preparation_attempts`. Protects: a fresh
 * PGLite install has the column (integer, NOT NULL, default 0, non-negative)
 * and an upgraded brain gets it with 0 on every existing request, whatever its
 * state, without the runner touching the rows. Fails when the migration is
 * missing from the registry, is not idempotent, or the column loses its
 * default or check. The Postgres twin is test/e2e/persistence-preparation-attempts-postgres.test.ts.
 */
import { afterAll, beforeAll, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { assertFreshPreparationAttemptsColumn, assertUpgradedPreparationAttemptsColumn } from './helpers/preparation-attempts-migration.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-preparation-attempts-'));
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_path: join(home, 'data') });
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('a fresh PGLite install has preparation_attempts with its default and check', async () => {
  await assertFreshPreparationAttemptsColumn(engine);
}, 30_000);

test('an upgraded PGLite brain gains preparation_attempts = 0 on queued, running, failed and compacted rows', async () => {
  await assertUpgradedPreparationAttemptsColumn(engine);
}, 60_000);
