/**
 * E5 executor binding matrix on PGLite (refactor wave 1, EO20). The case table
 * lives in test/helpers/executor-binding-matrix.ts; the direct-Postgres and
 * PgBouncer arms run the same table from test/e2e/executor-binding-matrix.test.ts.
 */
import { afterAll, beforeAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { defineExecutorBindingMatrix, engineSqlExecutor } from './helpers/executor-binding-matrix.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

defineExecutorBindingMatrix({ backend: 'pglite', getEngine: () => engine });
defineExecutorBindingMatrix({ backend: 'pglite', getEngine: () => engine, makeExecutor: engineSqlExecutor, executorName: 'engine-sql' });
