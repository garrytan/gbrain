/**
 * Segment garbage collection on Postgres (spec 3.5): the shared cases plus
 * the two-connection races (a sweep skips a text an open writer references;
 * a writer re-staging a text an open sweep deletes waits and re-inserts it),
 * and the JSONB double-encoding check PGLite can't catch. PGLite arm:
 * test/large-pages/segment-gc.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { defineSegmentGcCases } from '../helpers/segment-gc-cases.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

(hasDatabase() ? describe : describe.skip)('segment GC [postgres]', () => {
  let engine: PostgresEngine;
  beforeAll(async () => { engine = await setupDB(); }, 120_000);
  afterAll(async () => { await teardownDB(); });
  defineSegmentGcCases({ getEngine: () => engine, concurrentConnections: true });
});
