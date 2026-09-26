import { test, expect, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';

const vector = new Float32Array(1536);
vector[0] = 1;
mock.module('../src/core/embedding.ts', () => ({ ...realEmbedding, embedQuery: async () => vector, embed: async () => vector }));
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { operations } = await import('../src/core/operations.ts');
const { awaitPendingSearchCacheWrites } = await import('../src/core/search/hybrid.ts');

const home = mkdtempSync(join(process.env.TMPDIR!, 'drift-cache-'));
const originalHome = process.env.GBRAIN_HOME;

test('query cache real hit returns source-drift label through operation', async () => {
  process.env.GBRAIN_HOME = home;
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
  const engine = new PGLiteEngine();
  try {
    await engine.connect({});
    await engine.initSchema();
    await engine.putPage('notes/origin', { type: 'note', title: 'Origin', compiled_truth: 'original' });
    await engine.putPage('atoms/cachecase', {
      type: 'atom', title: 'Cache case', compiled_truth: 'cacheprovenance needle',
      frontmatter: { source_slug: 'notes/origin', source_hash: 'outdated' },
    });
    await engine.upsertChunks('atoms/cachecase', [{ chunk_index: 0, chunk_text: 'cacheprovenance needle', chunk_source: 'compiled_truth' }]);
    const query = operations.find(o => o.name === 'query')!;
    const ctx = { engine, config: {}, logger: console, dryRun: false, remote: false, sourceId: 'default', emitResponseMeta: (_: string, value: any) => { meta = value; } } as any;
    let meta: any;
    const params = { query: 'cacheprovenance', expand: false, limit: 5, autocut: false, use_cache: true };
    const first = await query.handler(ctx, params) as any[];
    expect(first.find(r => r.slug === 'atoms/cachecase')?.unverified_source_drift).toBe(true);
    await awaitPendingSearchCacheWrites();
    const rows = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM query_cache');
    expect(rows[0].n).toBeGreaterThan(0);
    const second = await query.handler(ctx, params) as any[];
    expect(meta.cache).toBe('hit');
    expect(second.find(r => r.slug === 'atoms/cachecase')?.unverified_source_drift).toBe(true);
  } finally {
    await engine.disconnect();
    resetGateway();
    if (originalHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
});
