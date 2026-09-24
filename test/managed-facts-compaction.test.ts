import { afterAll, beforeAll, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { exerciseFactCompaction, factCompactionCases } from './helpers/managed-facts-compaction-contract.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
for (const scenario of factCompactionCases) test(`compacted fact batch ${scenario}`, () => exerciseFactCompaction(engine, scenario), 60_000);
