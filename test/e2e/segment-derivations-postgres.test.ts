/**
 * Per-segment derivation rows and facts.source_window on Postgres (Wave B PR 4 interface, migration v273): the shared
 * cases, including the JSONB double-encoding checks PGLite can't catch. PGLite arm: test/engine-sql-segment-derivations.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { defineSegmentDerivationCases } from '../helpers/segment-derivation-cases.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

(hasDatabase() ? describe : describe.skip)('segment derivations [postgres]', () => {
  let engine: PostgresEngine;
  beforeAll(async () => { engine = await setupDB(); }, 120_000);
  afterAll(async () => { await teardownDB(); });
  defineSegmentDerivationCases({ getEngine: () => engine });
});
