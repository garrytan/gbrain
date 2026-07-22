/**
 * v0.42.x — Life Chronicle (#2390) feature eval harness (Phase A.9, PRIMARY proof).
 * The chronicle layer must answer EVERY gold task on the synthetic corpus.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runChronicleEval } from '../src/eval/chronicle/harness.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

describe('runChronicleEval', () => {
  test('scores a perfect 6/6 on the synthetic corpus (the value proof)', async () => {
    const result = await runChronicleEval(engine);
    const failed = result.tasks.filter((t) => !t.passed).map((t) => `${t.id}: ${t.detail}`);
    expect(failed).toEqual([]); // surfaces which gold task failed, if any
    expect(result.score).toBe(1);
    expect(result.total).toBe(6);
  });
});
