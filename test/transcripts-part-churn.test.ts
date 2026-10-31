/**
 * Transcript layouts on PGLite (Wave B PR 4, spec section 10): new sessions import as one page, split sessions stop
 * rewriting every part when they grow, nothing merges a split session. Shared cases:
 * test/helpers/transcripts-part-churn-cases.ts. Postgres arm: test/e2e/transcripts-part-churn-postgres.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { defineTranscriptPartChurnCases } from './helpers/transcripts-part-churn-cases.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('transcript part churn [pglite]', () => {
  defineTranscriptPartChurnCases({ getEngine: () => engine });
});
