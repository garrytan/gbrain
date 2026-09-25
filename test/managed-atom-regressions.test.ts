import { afterAll, beforeAll, beforeEach, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { retryStates, retryEdits, exerciseAtomRetryFence, exerciseAtomRetrySourceIsolation, atomWriteThroughValues, atomOwnerStates, exerciseAtomWriteThroughPolicy, atomDisabledAuthorityCases, exerciseAtomDisabledAuthority } from './helpers/managed-atom-regressions.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
beforeEach(async () => { await resetPgliteState(engine); });
afterAll(async () => { await engine.disconnect(); resetGateway(); });

test('atom retry fault stays scoped while an older source retry drains', () => exerciseAtomRetrySourceIsolation(engine), 60_000);

for (const state of retryStates) for (const edit of retryEdits) {
  test(`atom retry ${state} preserves reviewed target ${edit}`, () => exerciseAtomRetryFence(engine, state, edit), 60_000);
}
for (const value of atomWriteThroughValues) for (const owner of atomOwnerStates) {
  test(`atom write-through ${value} with ${owner} owner`, () => exerciseAtomWriteThroughPolicy(engine, value, owner), 60_000);
}
for (const scenario of atomDisabledAuthorityCases) {
  test(`database-only atom extraction retains ${scenario} fence`, () => exerciseAtomDisabledAuthority(engine, scenario), 60_000);
}
