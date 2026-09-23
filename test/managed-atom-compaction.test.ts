import { afterAll, beforeAll, beforeEach, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { atomCompactionCases, atomCompactionActions, exerciseAtomCompaction } from './helpers/managed-atom-compaction.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
beforeEach(async () => { await resetPgliteState(engine); });
afterAll(async () => { await engine.disconnect(); resetGateway(); });

for (const scenario of atomCompactionCases) for (const action of atomCompactionActions) {
  test(`compacted atom ${scenario} ${action} does not repeat extraction`, () => exerciseAtomCompaction(engine, scenario, action), 60_000);
}
