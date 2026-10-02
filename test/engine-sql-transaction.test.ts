/**
 * Engine-sql transaction atomicity on PGLite (refactor wave 1, EO1 / T-G1).
 * Every migrated domain write performed through `engine.transaction()` /
 * `transactionDirect()` that then throws is rolled back. Postgres arm (with a
 * concurrent pool read and dual-pool transactionDirect):
 * test/e2e/engine-sql-transaction-parity.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { defineRollbackCases } from './helpers/engine-sql-rollback-cases.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('engine-sql write-then-throw rollback [pglite]', () => {
  defineRollbackCases({ getEngine: () => engine, entryPoints: ['transaction', 'transactionDirect'], concurrentPoolRead: false });
});
