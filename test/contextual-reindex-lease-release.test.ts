import { expect, test } from 'bun:test';
import { makeContextualReindexHandler } from '../src/core/minions/handlers/contextual-reindex-per-chunk.ts';

test('releases a Postgres string synopsis lease id', async () => {
  const deletes: Array<{ sql: string; params?: unknown[] }> = [];
  const engine = {
    async getPage() {
      return { source_id: 'default' };
    },
    async getConfig() {
      return null;
    },
    async executeRaw(sql: string, params?: unknown[]) {
      deletes.push({ sql, params });
      return [];
    },
  };
  const handler = makeContextualReindexHandler({
    engine: engine as never,
    reembedPage: async (args) => {
      await args.releaseSynopsisLease?.('26016');
      return {
        kind: 'success',
        mode_applied: 'per_chunk_synopsis',
        chunks_embedded: 1,
        corpus_generation: 'test-generation',
      };
    },
  });
  await handler({
    id: 42,
    data: { page_slug: 'wiki/example' },
    signal: new AbortController().signal,
  } as never);
  expect(deletes).toEqual([{
    sql: 'DELETE FROM subagent_rate_leases WHERE id = $1',
    params: [26016],
  }]);
});
