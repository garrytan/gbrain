import { describe, expect, mock, test } from 'bun:test';

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(1536)),
}));

describe('embed --stale source scoping', () => {
  test('runEmbedCore threads stale source_id into chunk reads and writes', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const calls: Array<{ method: string; slug: string; sourceId?: string }> = [];
    const chunks = [{
      chunk_index: 0,
      chunk_text: 'support kb text',
      chunk_source: 'compiled_truth' as const,
      embedded_at: null,
      token_count: 4,
    }];
    const engine = {
      countStaleChunks: async () => 1,
      listStaleChunks: async () => [{
        source_id: 'openclaw-support-kb',
        slug: 'shared-slug',
        chunk_index: 0,
        chunk_text: 'support kb text',
        chunk_source: 'compiled_truth' as const,
        model: null,
        token_count: 4,
      }],
      getChunks: async (slug: string, opts?: { sourceId?: string }) => {
        calls.push({ method: 'getChunks', slug, sourceId: opts?.sourceId });
        return chunks;
      },
      upsertChunks: async (slug: string, _chunks: unknown[], opts?: { sourceId?: string }) => {
        calls.push({ method: 'upsertChunks', slug, sourceId: opts?.sourceId });
      },
    };

    await runEmbedCore(engine as never, { stale: true });

    expect(calls).toEqual([
      { method: 'getChunks', slug: 'shared-slug', sourceId: 'openclaw-support-kb' },
      { method: 'upsertChunks', slug: 'shared-slug', sourceId: 'openclaw-support-kb' },
    ]);
  });

  test('runEmbedCore scopes stale count/list queries when sourceId is provided', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const staleQueryOpts: Array<{ sourceId?: string } | undefined> = [];
    const engine = {
      countStaleChunks: async (opts?: { sourceId?: string }) => {
        staleQueryOpts.push(opts);
        return 0;
      },
      listStaleChunks: async (opts?: { sourceId?: string }) => {
        staleQueryOpts.push(opts);
        return [];
      },
    };

    await runEmbedCore(engine as never, { stale: true, sourceId: 'openclaw-support-kb' });

    expect(staleQueryOpts).toEqual([{ sourceId: 'openclaw-support-kb' }]);
  });
});
