/**
 * `query` with no `autocut` parameter does not cut, in either reranked mode.
 *
 * Autocut is off in every search-mode bundle (ranker wave rule R2: the cut at
 * the steepest rerank-score drop lost the second relevant session on
 * multi-part questions). The agent-facing `autocut` param text once said
 * "Default on"; this pins the behavior the text now describes: an omitted
 * `autocut` returns the full reranked set even when the rerank scores have a
 * cliff, and `autocut: true` is what trims at that cliff.
 *
 * Serial: configures the process-global gateway and its test transports.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { runModePicker } from '../../src/commands/init-mode-picker.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import {
  configureGateway, resetGateway,
  __setEmbedTransportForTests, __setRerankTransportForTests, __clearQueryEmbedCacheForTests,
} from '../../src/core/ai/gateway.ts';

const DIMS = 1536;
const CLIFF = [0.95, 0.9, 0.2, 0.15, 0.1];
const SLUGS = ['notes/a', 'notes/b', 'notes/c', 'notes/d', 'notes/e'];
let reranks = 0;

beforeAll(() => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test', VOYAGE_API_KEY: 'pa-test' },
  });
  __setEmbedTransportForTests((async (p: { values: string[] }) => ({
    embeddings: p.values.map(() => Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0.01))),
  })) as never);
  __setRerankTransportForTests(async (_url, init) => {
    reranks++;
    const docs = (JSON.parse(String(init.body)) as { documents: string[] }).documents;
    return new Response(JSON.stringify({ results: docs.map((_, index) => ({ index, relevance_score: CLIFF[index] ?? 0.01 })) }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
});

afterAll(() => {
  __setEmbedTransportForTests(null);
  __setRerankTransportForTests(null);
  resetGateway();
});

const ctx = (engine: PGLiteEngine): OperationContext =>
  ({ engine, remote: false, sourceId: 'default', config: { engine: 'pglite' }, logger: console, dryRun: false }) as OperationContext;

async function slugs(engine: PGLiteEngine, params: Record<string, unknown>): Promise<string[]> {
  __clearQueryEmbedCacheForTests();
  const rows = await operationsByName.query.handler(ctx(engine), { query: 'alpha keyword', expand: false, ...params }) as Array<{ slug: string }>;
  return [...new Set(rows.map((r) => r.slug))].sort();
}

describe('query: autocut is off unless asked for', () => {
  for (const mode of ['balanced', 'tokenmax'] as const) {
    test(`${mode}: omitted autocut returns the full reranked set; autocut:true cuts at the cliff`, async () => {
      const engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      try {
        const log = console.log;
        console.log = () => {};
        try { await runModePicker(engine, { explicit: mode }); } finally { console.log = log; }
        for (const [i, slug] of SLUGS.entries()) {
          const text = `alpha keyword ${['one', 'two', 'three', 'four', 'five'][i]}`;
          await engine.putPage(slug, { type: 'note', title: slug.slice(6).toUpperCase(), compiled_truth: text });
          await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: `${text} chunk`, chunk_source: 'compiled_truth' }]);
        }

        reranks = 0;
        const omitted = await slugs(engine, {});
        expect(reranks).toBeGreaterThan(0);
        expect(omitted).toEqual(SLUGS);
        expect(await slugs(engine, { autocut: false })).toEqual(omitted);
        expect((await slugs(engine, { autocut: true })).length).toBe(2);
      } finally {
        await engine.disconnect();
      }
    }, 60_000);
  }
});
