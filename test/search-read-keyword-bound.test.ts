/**
 * Wave B PR 2: the segmented-region read (search/dedup.ts segmentRegions: the chunk-manifest probe plus the region
 * SELECT, both naming content_chunks) runs in one read transaction under the keyword statement bound
 * (`search.keyword_statement_timeout_ms`), and its existing fallback (every page under the inline rule) answers a
 * statement the bound cancels.
 *
 * Contract protected: on a fresh engine (no cached probe answer) a session holding ACCESS EXCLUSIVE on
 * content_chunks cannot hold the read past the knob: segmentRegions returns its empty map. Regression that fails it:
 * either statement issued through `engine.executeRaw` with no statement_timeout, which waits on the lock for as long
 * as the lock lasts.
 *
 * BrainEngine.keywordBoundedRead is the seam: Postgres runs the read in one transaction under the knob's
 * statement_timeout (file plane over DB plane); PGLite runs it on the engine itself with no statement timeout.
 * The lock arm is Postgres only (DATABASE_URL): PGLite has no concurrent locker.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { KEYWORD_STATEMENT_TIMEOUT_KEY } from '../src/core/postgres-engine/keyword-statement-timeout.ts';
import { segmentRegions } from '../src/core/search/dedup.ts';
import { ensureSearchStatistics } from '../src/core/search/projection-statistics.ts';
import type { SearchResult } from '../src/core/types.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

describe('PGLite keywordBoundedRead runs the read on the engine itself', () => {
  let engine: PGLiteEngine;
  beforeAll(() => { engine = new PGLiteEngine(); });

  test('the read receives the engine itself (no transaction, no statement timeout)', async () => {
    expect(await engine.keywordBoundedRead(async db => db)).toBe(engine);
  });
});

if (testBackends().includes('postgres')) {
  describe('postgres: a content_chunks lock cannot hold the segmented-region read past the keyword bound', () => {
    let engine: PostgresEngine;
    let databaseUrl: string;
    let close: () => Promise<void>;
    let locker: ReturnType<typeof postgres>;
    let chunkIds: number[];

    beforeAll(async () => {
      ({ engine, databaseUrl, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      await engine.putPage('notes/alpha', { type: 'note', title: 'Alpha', compiled_truth: 'alpha beta gamma' });
      await installFixtureChunks(engine, 'notes/alpha', [0, 1, 2].map(i => ({ chunk_index: i, chunk_text: `alpha part ${i}`, chunk_source: 'compiled_truth' as const })));
      chunkIds = (await engine.executeRaw<{ id: number }>('SELECT cc.id FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = $1 ORDER BY cc.chunk_index', ['notes/alpha'])).map(r => Number(r.id));
      // Statistics present, so a fresh engine's background refresh (guardSearchStatistics) never queues an ANALYZE behind the lock.
      await ensureSearchStatistics(engine);
      await engine.setConfig(KEYWORD_STATEMENT_TIMEOUT_KEY, '1000');
      locker = postgres(databaseUrl, { max: 1, prepare: false });
    }, 120_000);
    afterAll(async () => {
      await locker?.end({ timeout: 5 }).catch(() => {});
      await close?.();
    });

    /** Runs `run` on a fresh engine while a session holds ACCESS EXCLUSIVE on content_chunks; 'hung' after 30 s. */
    async function underLock<T>(run: (fresh: PostgresEngine) => Promise<T>): Promise<{ ms: number; outcome: 'hung' | { value: T } | { code: string } }> {
      const fresh = new PostgresEngine();
      await fresh.connect({ database_url: databaseUrl, poolSize: 2 });
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      let locked!: () => void;
      const lockedUp = new Promise<void>(resolve => { locked = resolve; });
      const held = locker.begin(async tx => {
        await tx.unsafe('LOCK TABLE content_chunks IN ACCESS EXCLUSIVE MODE');
        locked();
        await released;
      }).catch(() => {});
      await lockedUp;
      const started = performance.now();
      const call = run(fresh).then(value => ({ value }), (error: unknown) => ({ code: String((error as { code?: string }).code ?? (error as Error).message) }));
      try {
        const outcome = await Promise.race([call, new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 30_000))]);
        return { ms: performance.now() - started, outcome };
      } finally {
        release();
        await held;
        await call;
        await fresh.disconnect();
      }
    }

    const hit = (chunk_id: number): SearchResult => ({ slug: 'notes/alpha', source_id: 'default', page_id: 0, title: 'Alpha', type: 'note', chunk_id, chunk_index: 0, chunk_text: '', chunk_source: 'compiled_truth', score: 1, stale: false } as SearchResult);

    test('keywordBoundedRead binds the knob as the transaction\'s statement_timeout, the file plane over the DB plane', async () => {
      const read = (fresh: PostgresEngine) => fresh.keywordBoundedRead(async db => (await db.executeRaw<{ t: string }>("SELECT current_setting('statement_timeout') AS t"))[0]?.t);
      for (const [config, expected] of [[{}, '1s'], [{ keyword_statement_timeout_ms: 2500 }, '2500ms']] as const) {
        const fresh = new PostgresEngine();
        await fresh.connect({ database_url: databaseUrl, poolSize: 2, ...config });
        try {
          expect(await read(fresh)).toBe(expected);
          expect((await fresh.executeRaw<{ t: string }>("SELECT current_setting('statement_timeout') AS t"))[0]?.t).not.toBe(expected);
        } finally {
          await fresh.disconnect();
        }
      }
    }, 60_000);

    test('segmentRegions answers its empty map within the 1000 ms knob', async () => {
      const { ms, outcome } = await underLock(fresh => segmentRegions(fresh, chunkIds.map(hit)));
      expect(outcome, `segmentRegions after ${ms.toFixed(0)} ms`).toEqual({ value: new Map() });
      expect(ms).toBeGreaterThanOrEqual(900);
      expect(ms).toBeLessThan(4000);
    }, 60_000);

    test('once the lock is gone the region read answers', async () => {
      const fresh = new PostgresEngine();
      await fresh.connect({ database_url: databaseUrl, poolSize: 2 });
      try {
        expect(await segmentRegions(fresh, chunkIds.map(hit))).toEqual(new Map());
      } finally {
        await fresh.disconnect();
      }
    }, 60_000);
  });
}
