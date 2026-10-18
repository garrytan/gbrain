/**
 * Pinned questions (C4) on PGLite: the B5 offline safety gate, operator
 * journeys and the dream.auto_think migration. Scenarios live in
 * test/helpers/pinned-questions-scenarios.ts and also run on live Postgres
 * (test/e2e/pinned-questions-postgres.test.ts). Stub model; no network.
 */
import { afterAll, beforeAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerPinnedQuestionSuite } from './helpers/pinned-questions-scenarios.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine?.disconnect();
}, 60_000);

registerPinnedQuestionSuite('pglite', () => engine);
