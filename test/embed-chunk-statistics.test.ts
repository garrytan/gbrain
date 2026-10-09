/**
 * E5.4: an embed drain that embedded something refreshes the content_chunks
 * planner statistics once (Postgres), so vector search keeps its HNSW plan
 * instead of sorting every candidate on a stats-less table. A dry run and a
 * drain with nothing to embed issue no ANALYZE.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { CHUNK_STATISTICS_SQL } from '../src/core/search/projection-statistics.ts';
import { mockEmbedProjectionEngine as mockEngine } from './helpers/embed-projection-mock.ts';

const DIMS = 1536;

beforeEach(() => {
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({
    embeddings: values.map(() => Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0))),
    usage: { tokens: values.length },
  })) as never);
});

afterEach(() => __setEmbedTransportForTests(null));
afterAll(() => resetGateway());

function staleEngine(pages: number) {
  const stale = Array.from({ length: pages }, (_, i) => ({
    slug: `notes/stats-${i}`, chunk_index: 0, chunk_text: `Synthetic text for notes/stats-${i}.`, chunk_source: 'compiled_truth' as const,
    model: null, token_count: 4, source_id: 'default', page_id: i + 1,
  }));
  let served = false;
  const engine = mockEngine({
    kind: 'postgres',
    countStaleChunks: async () => (served ? 0 : pages),
    listStaleChunks: async () => { if (served || pages === 0) return []; served = true; return stale; },
    getChunks: async (slug: string) => [{ chunk_index: 0, chunk_text: `Synthetic text for ${slug}.`, chunk_source: 'compiled_truth', embedded_at: null, token_count: 4 }],
    upsertChunks: async () => {},
  });
  const analyzed = () => ((engine as unknown as { _calls: Array<{ method: string; args: unknown[] }> })._calls)
    .filter(c => c.method === 'executeRaw' && String(c.args[0]).startsWith('ANALYZE')).map(c => String(c.args[0]));
  return { engine, analyzed };
}

describe('embed drain chunk statistics', () => {
  test('a drain that embedded chunks runs one bounded ANALYZE of content_chunks', async () => {
    const { engine, analyzed } = staleEngine(5);
    const result = await runEmbedCore(engine, { stale: true, quiet: true });
    expect(result.embedded).toBe(5);
    expect(analyzed()).toEqual([CHUNK_STATISTICS_SQL]);
  });

  test('a dry run and an empty drain issue no ANALYZE', async () => {
    for (const [pages, dryRun] of [[5, true], [0, false]] as const) {
      const { engine, analyzed } = staleEngine(pages);
      await runEmbedCore(engine, { stale: true, quiet: true, dryRun });
      expect(analyzed()).toEqual([]);
    }
  });
});
