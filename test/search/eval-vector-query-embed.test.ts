/**
 * Read-path audit #9: `gbrain eval --strategy vector` embedded queries with
 * the DOCUMENT-side `embed()`; hybrid uses `embedQuery` (input_type=query on
 * asymmetric providers), so the vector baseline was handicapped. The vector
 * strategy must send the query-side input type.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runEval } from '../../src/core/search/eval.ts';

let engine: PGLiteEngine;
const seen: Array<Record<string, unknown> | undefined> = [];

beforeAll(async () => {
  configureGateway({ embedding_model: 'voyage:voyage-3-large', embedding_dimensions: 1024, env: { VOYAGE_API_KEY: 'test' } });
  __setEmbedTransportForTests((async (p: any) => {
    seen.push(p.providerOptions?.openaiCompatible);
    return { embeddings: p.values.map(() => Array.from({ length: 1024 }, () => 0.1)), values: p.values, usage: { tokens: 1 } };
  }) as any);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('eval vector strategy', () => {
  test('embeds the query with input_type=query', async () => {
    const report = await runEval(engine, [{ query: 'widget pricing', relevant: ['notes/a'] }], { strategy: 'vector' }, 5);
    expect(report.queries.length).toBe(1);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(o => o?.input_type === 'query')).toBe(true);
  }, 60_000);
});
