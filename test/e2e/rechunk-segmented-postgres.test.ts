/**
 * The re-chunk of segmented pages sealed at an older segmented chunker on Postgres (Wave B PR 4, lane recall): the
 * shared cases. PGLite arm: test/large-pages/rechunk-segmented.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { defineRechunkSegmentedCases } from '../helpers/rechunk-segmented-cases.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

(hasDatabase() ? describe : describe.skip)('reindex --segmented [postgres]', () => {
  let engine: PostgresEngine;
  beforeAll(async () => { engine = await setupDB(); }, 120_000);
  afterAll(async () => { await teardownDB(); });
  defineRechunkSegmentedCases({ getEngine: () => engine });
});
