import { afterAll, beforeAll, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { exerciseManagedEmbedding, managedEmbeddingCases } from './helpers/managed-facts-embedding-contract.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
for (const scenario of managedEmbeddingCases) test(`managed fact embedding ${scenario}`, () => exerciseManagedEmbedding(engine, scenario), 60_000);
