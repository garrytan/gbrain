/**
 * Transcript layouts on Postgres (Wave B PR 4, spec section 10): the shared cases in
 * test/helpers/transcripts-part-churn-cases.ts. PGLite arm: test/transcripts-part-churn.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { defineTranscriptPartChurnCases } from '../helpers/transcripts-part-churn-cases.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

(hasDatabase() ? describe : describe.skip)('transcript part churn [postgres]', () => {
  let engine: PostgresEngine;
  beforeAll(async () => { engine = await setupDB(); }, 120_000);
  afterAll(async () => { await teardownDB(); });
  defineTranscriptPartChurnCases({ getEngine: () => engine, databaseUrl: process.env.DATABASE_URL });
});
