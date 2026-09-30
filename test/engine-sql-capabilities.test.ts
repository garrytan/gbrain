/**
 * Engine-sql dialect capabilities on PGLite (refactor wave 1): bind batching,
 * advisory locks and embedding-cast probing, each with a boundary-size and a
 * concurrent-write case. Postgres arm: test/e2e/engine-sql-capabilities-parity.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { defineCapabilityCases } from './helpers/engine-sql-capability-cases.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('engine-sql capabilities [pglite]', () => {
  defineCapabilityCases({ family: 'pglite', getEngine: () => engine });
});
