/**
 * Engine-sql dialect capabilities on Postgres (refactor wave 1): bind
 * batching, transaction-scoped advisory locks and embedding-cast probing, each
 * with a boundary-size and a concurrent-write case, on direct Postgres and
 * PgBouncer (scripts/e2e-backend-matrix.txt). PGLite arm:
 * test/engine-sql-capabilities.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { defineCapabilityCases } from '../helpers/engine-sql-capability-cases.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const backend = process.env.GBRAIN_TEST_BACKEND ?? 'postgres-direct';

(hasDatabase() ? describe : describe.skip)(`engine-sql capabilities [${backend}]`, () => {
  let engine: PostgresEngine;
  beforeAll(async () => { engine = await setupDB(); }, 120_000);
  afterAll(async () => { await teardownDB(); });
  defineCapabilityCases({ family: 'postgres', getEngine: () => engine });
});
