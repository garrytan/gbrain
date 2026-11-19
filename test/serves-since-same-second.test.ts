/** GST-3199 on PGLite: the requester-scope grace boundary inside one second. Cases: test/helpers/serves-since-same-second.ts. */
import { afterAll, beforeAll, beforeEach, describe } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { sameSecondTests } from './helpers/serves-since-same-second.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw('DELETE FROM access_tokens');
  await engine.executeRaw('DELETE FROM access_members');
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'access.serves%'`);
});

describe('requester-scope grace within one second (PGLite)', () => {
  sameSecondTests(async () => ({ engine, close: async () => {} }));
});
