/**
 * Per-segment derivation rows and facts.source_window on PGLite (Wave B PR 4 interface, migration v265). Postgres arm:
 * test/e2e/segment-derivations-postgres.test.ts. Pure planning and hashing helpers: test/large-pages/segment-derivations-plan.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { defineSegmentDerivationCases } from './helpers/segment-derivation-cases.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('segment derivations [pglite]', () => {
  defineSegmentDerivationCases({ getEngine: () => engine });
});
