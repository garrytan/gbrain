import { afterAll, beforeAll, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { exerciseFactsWorkerConfig } from './helpers/facts-worker-config-contract.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); resetGateway(); });

test('facts worker preserves embedding-disabled config in its newly started consumer', () => exerciseFactsWorkerConfig(engine), 60_000);
