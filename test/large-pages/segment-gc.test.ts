/**
 * Segment garbage collection on PGLite (spec 3.5): text grace and the
 * manifest foreign key, staging expiry, versions as roots, orphan staged
 * chunks, JSONB and bytea round-trips. Postgres arm (adds the two-connection
 * races): test/e2e/segment-gc-parity.test.ts.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { defineSegmentGcCases } from '../helpers/segment-gc-cases.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('segment GC [pglite]', () => {
  defineSegmentGcCases({ getEngine: () => engine, concurrentConnections: false });
});
