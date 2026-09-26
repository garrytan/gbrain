import { test, expect } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { awaitPendingSearchCacheWrites } from '../src/core/search/hybrid.ts';

test('query repeat returns source-drift label while semantic result cache is disabled upstream', async () => {
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
    await engine.executeRaw('UPDATE pages SET text_projection_revision = knowledge_revision WHERE slug = $1', ['atoms/cachecase']);
    const query = operations.find(o => o.name === 'query')!;
    const ctx = { engine, config: {}, logger: console, dryRun: false, remote: false, sourceId: 'default', emitResponseMeta: (_: string, value: any) => { meta = value; } } as any;
    let meta: any;
    const params = { query: 'cacheprovenance', expand: false, limit: 5, autocut: false, use_cache: true };
    const first = await query.handler(ctx, params) as any[];
    expect(first.find(r => r.slug === 'atoms/cachecase')?.unverified_source_drift).toBe(true);
    await awaitPendingSearchCacheWrites();
    const rows = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM query_cache');
    expect(rows[0].n).toBe(0);
    const second = await query.handler(ctx, params) as any[];
    expect(meta.cache).toBe('disabled');
    expect(second.find(r => r.slug === 'atoms/cachecase')?.unverified_source_drift).toBe(true);
  } finally {
    await engine.disconnect();
  }
});
