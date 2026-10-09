import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runReindexSearchVector } from '../src/commands/reindex-search-vector.ts';
import { FTS_REINDEX_MARKER_KEY, resetFtsLanguageCache } from '../src/core/fts-language.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { sealPageTextProjection } from '../src/core/page-state/projections.ts';
import { FACTS_FENCE_BEGIN, renderFactsTable } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

for (const backend of testBackends()) describe(`page FTS reindex ${backend}`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  let databaseUrl: string;
  beforeAll(async () => {
    await withEnv({ GBRAIN_FTS_LANGUAGE: 'english' }, async () => {
      resetFtsLanguageCache();
      if (backend === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine; close = pg.close; databaseUrl = pg.databaseUrl;
      } else {
        engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect();
      }
    });
    resetFtsLanguageCache();
  }, 120_000);
  afterAll(async () => { await close(); resetFtsLanguageCache(); });

  async function reindex(language: string) {
    return withEnv({ GBRAIN_FTS_LANGUAGE: language }, async () => {
      resetFtsLanguageCache();
      try { return await runReindexSearchVector(engine, { yes: true, json: true }); }
      finally { resetFtsLanguageCache(); }
    });
  }
  async function state(slug: string) {
    return (await engine.executeRaw<{ title: string; timeline: string; knowledge_revision: string; text_projection_revision: string | null; vector: string }>(
      "SELECT title,timeline,knowledge_revision,text_projection_revision,search_vector::text AS vector FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!;
  }
  async function expected(language: string, title: string, timeline: string) {
    return (await engine.executeRaw<{ vector: string }>(
      `SELECT (setweight(to_tsvector('${language}',$1::text),'A') || setweight(to_tsvector('${language}',$2::text),'C'))::text AS vector`,
      [title, sanitizeRemoteBody(timeline)]))[0]!.vector;
  }
  async function page(slug: string, timeline: string) {
    await engine.putPage(slug, { type: 'note', title: 'Running runners', compiled_truth: 'Unindexed body', timeline }, { sourceId: 'default' });
    await sealPageTextProjection(engine, slug, 'default');
  }

  test('changing language retokenizes existing page titles and timelines, not only future writes', async () => {
    await page('fts-language', 'Running observations');
    await engine.upsertChunks('fts-language', [{ chunk_index: 0, chunk_text: 'Running observations', chunk_source: 'compiled_truth' }], { sourceId: 'default' });
    await sealPageTextProjection(engine, 'fts-language', 'default');
    const before = await state('fts-language');
    const want = await expected('simple', before.title, before.timeline);
    expect(before.vector).not.toBe(want);
    await reindex('simple');
    expect(await state('fts-language')).toEqual({ ...before, vector: want });
    const chunks = await engine.executeRaw<{ matches: boolean; chunk_text: string }>(
      "SELECT search_vector @@ to_tsquery('simple','running') AS matches,chunk_text FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE source_id='default' AND slug='fts-language')");
    expect(chunks).toEqual([{ matches: true, chunk_text: 'Running observations' }]);
    expect(await engine.getConfig('fts.reindex_in_progress')).toBeNull();
    await reindex('english');
    expect(await state('fts-language')).toEqual(before);
  });

  test('reindex keeps private and withdrawn facts, takes, and malformed fences out of the sealed vector', async () => {
    const facts = renderFactsTable([
      { rowNum: 1, claim: 'publicneedle', visibility: 'world', kind: 'fact', confidence: 1, notability: 'medium', active: true },
      { rowNum: 2, claim: 'privateneedle', visibility: 'private', kind: 'fact', confidence: 1, notability: 'medium', active: true },
      { rowNum: 3, claim: 'withdrawnneedle', visibility: 'world', kind: 'fact', confidence: 1, notability: 'medium', active: false, forgotten: true, context: 'forgotten: test withdrawal' },
    ]);
    const bodies = [
      `Running public timeline\n${facts}\n${TAKES_FENCE_BEGIN}\nsecretstake\n${TAKES_FENCE_END}`,
      `Running public timeline\n${FACTS_FENCE_BEGIN}\nmalformedneedle`,
    ];
    for (const [i, timeline] of bodies.entries()) {
      const slug = `fts-protected-${i}`;
      await page(slug, timeline);
      const before = await state(slug);
      await reindex('simple');
      const after = await state(slug);
      expect(after).toEqual({ ...before, vector: await expected('simple', before.title, timeline) });
      for (const hidden of ['privateneedle', 'withdrawnneedle', 'secretstake', 'malformedneedle']) expect(after.vector).not.toContain(hidden);
      if (i === 0) expect(after.vector).toContain('publicneedle');
      await reindex('english');
    }
  });

  test('a failed page batch rolls its vectors back, retains the incomplete marker and retries without losing rows', async () => {
    await page('fts-rollback', 'Running rollback observations');
    const before = await state('fts-rollback');
    const transaction = engine.transaction;
    engine.transaction = async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => transaction.call(engine, async tx => {
      await fn(tx);
      throw new Error('injected page batch failure');
    }) as Promise<T>;
    try { await expect(reindex('simple')).rejects.toThrow('injected page batch failure'); }
    finally { engine.transaction = transaction; }
    expect(await state('fts-rollback')).toEqual(before);
    expect(await engine.getConfig(FTS_REINDEX_MARKER_KEY)).toBe('simple');
    expect(await engine.getConfig('backfill.fts_pages.last_id')).toBeNull();
    await reindex('simple');
    expect(await state('fts-rollback')).toEqual({ ...before, vector: await expected('simple', before.title, before.timeline) });
    expect(await engine.getConfig(FTS_REINDEX_MARKER_KEY)).toBeNull();
    await reindex('english');
  });

  if (backend === 'postgres') test('the page read and vector replacement hold the same row lock against concurrent edits', async () => {
    await page('fts-concurrent', 'Running original observations');
    const other = new PostgresEngine();
    await other.connect({ database_url: databaseUrl, poolSize: 2 });
    const transaction = engine.transaction;
    const read = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    engine.transaction = async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => transaction.call(engine, async tx => {
      const execute = tx.executeRaw.bind(tx);
      tx.executeRaw = async <R>(sql: string, params?: unknown[], opts?: { signal?: AbortSignal }): Promise<R[]> => {
        const rows = await execute<R>(sql, params, opts);
        if (sql.includes('FOR UPDATE') && sql.includes('SELECT id,timeline')) {
          read.resolve(); await release.promise;
        }
        return rows;
      };
      return fn(tx);
    }) as Promise<T>;
    const running = reindex('simple');
    try {
      await read.promise;
      await expect(other.transaction(async tx => {
        await tx.executeRaw("SET LOCAL lock_timeout='100ms'");
        await tx.executeRaw("UPDATE pages SET timeline='New timeline' WHERE source_id='default' AND slug='fts-concurrent'");
      })).rejects.toMatchObject({ code: '55P03' });
      release.resolve(); await running;
      await other.executeRaw("UPDATE pages SET timeline='New timeline' WHERE source_id='default' AND slug='fts-concurrent'");
      const current = await state('fts-concurrent');
      expect(current.timeline).toBe('New timeline');
      expect(current.vector).toBe(await expected('simple', current.title, current.timeline));
    } finally {
      release.resolve(); await running;
      engine.transaction = transaction;
      await other.disconnect();
    }
    await reindex('english');
  }, 30_000);
});
