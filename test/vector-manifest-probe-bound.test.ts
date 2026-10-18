/**
 * Wave B PR 2: searchVector and explainVectorSearch run the chunk-manifest probe (chunkManifestReads) inside each
 * attempt's bounded transaction, after its statement_timeout, never as a separate statement before it.
 *
 * Contract protected: on a fresh engine (no cached probe answer) a session holding ACCESS EXCLUSIVE on
 * content_chunks cannot hold a vector search past its bound: searchVector returns an incomplete, underfilled pool
 * (reason `deadline`) within the walk and pool budgets, and explainVectorSearch fails with 57014 at its 8 s attempt
 * budget. Regression that fails it: the probe issued through `engine.executeRaw` before the attempt's transaction,
 * which names content_chunks and so waits on the lock with no statement_timeout at all (the probe hung forever).
 *
 * Unit arm: the real engine methods over a recording transaction handle (no database). Postgres arm (DATABASE_URL):
 * a real locker session.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { searchSettingsStatement, type SearchSettings } from '../src/core/postgres-engine/search-settings.ts';
import { ensureSearchStatistics } from '../src/core/search/projection-statistics.ts';
import type { SearchOpts } from '../src/core/types.ts';
import { embeddingDims, prngUnitVector } from './helpers/ef-search-fixture.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const { default: Connection } = await import(new URL('../vendor/postgres/src/connection.js', import.meta.url).href) as {
  default: { statementTimeoutChanges: (text: string, parameters?: unknown[]) => Array<{ kind: string; ms?: number }> };
};

const MANIFEST_PROBE = /has_table_privilege\('page_body_manifest'/;

interface Recorded { sql: string; params: unknown[]; tx: number | null }

/** A PostgresEngine whose scoped read transactions run over a recording handle; statements outside one record tx null. */
function recordingEngine(): { engine: PostgresEngine; recorded: Recorded[] } {
  const engine = new PostgresEngine();
  const recorded: Recorded[] = [];
  let txCount = 0;
  let current: number | null = null;
  const rows = (sql: string): unknown[] => {
    if (/AS eligible/.test(sql)) return [{ eligible: 0 }];
    if (/extversion/.test(sql)) return [{ extversion: '0.8.0' }];
    return Object.assign([], { count: 0 });
  };
  const record = (sql: string, params: unknown[] = []) => { recorded.push({ sql, params, tx: current }); return rows(sql); };
  const tx = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => record(strings.join('$'), values),
    { unsafe: async (sql: string, params?: unknown[]) => record(sql, params) });
  const priv = engine as unknown as {
    withScopedReadTransaction: (ids: unknown, id: unknown, cb: (tx: unknown) => Promise<unknown>, opts?: { settings?: SearchSettings | (() => SearchSettings) }) => Promise<unknown>;
    executeRaw: (sql: string, params?: unknown[]) => Promise<unknown[]>;
    _pageTransaction: boolean;
  };
  priv.withScopedReadTransaction = async (_ids, _id, cb, txOpts) => {
    current = ++txCount;
    try {
      const settings = typeof txOpts?.settings === 'function' ? txOpts.settings() : txOpts?.settings;
      if (settings) { const set = searchSettingsStatement(settings); record(set.sql, set.params); }
      return await cb(tx);
    } finally { current = null; }
  };
  priv.executeRaw = async (sql, params) => record(sql, params);
  priv._pageTransaction = true;
  return { engine, recorded };
}

const SITES: Record<string, (engine: PostgresEngine, embedding: Float32Array, opts?: SearchOpts) => Promise<unknown>> = {
  searchVector: (engine, embedding, opts) => engine.searchVector(embedding, opts),
  explainVectorSearch: (engine, embedding, opts) => engine.explainVectorSearch(embedding, opts),
};

describe('the vector chunk-manifest probe runs inside each bounded attempt (recording handle)', () => {
  for (const site of Object.keys(SITES)) {
    test(`${site}: no statement outside a transaction names content_chunks, and every probe follows its attempt's statement_timeout`, async () => {
      const { engine, recorded } = recordingEngine();
      await SITES[site](engine, new Float32Array(8).fill(0.25));
      expect(recorded.filter(r => r.tx === null && /content_chunks|page_body_manifest/.test(r.sql)).map(r => r.sql)).toEqual([]);
      const probes = recorded.filter(r => MANIFEST_PROBE.test(r.sql));
      expect(probes.length).toBeGreaterThan(0);
      for (const probe of probes) {
        const before = recorded.slice(0, recorded.indexOf(probe)).filter(r => r.tx === probe.tx);
        expect(before.some(r => Connection.statementTimeoutChanges(r.sql, r.params).some(change => change.kind === 'set')), probe.sql).toBe(true);
      }
    });
  }
});

if (testBackends().includes('postgres')) {
  describe('postgres: a content_chunks lock cannot hold a vector search past its bound', () => {
    let engine: PostgresEngine;
    let databaseUrl: string;
    let close: () => Promise<void>;
    let locker: ReturnType<typeof postgres>;
    let embedding: Float32Array;

    beforeAll(async () => {
      ({ engine, databaseUrl, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      await engine.putPage('notes/alpha', { type: 'note', title: 'Alpha', compiled_truth: 'alpha beta gamma' });
      embedding = prngUnitVector(1, await embeddingDims(engine));
      await installFixtureChunks(engine, 'notes/alpha', [{ chunk_index: 0, chunk_text: 'alpha beta gamma', chunk_source: 'compiled_truth', embedding }]);
      // Statistics present, so a fresh engine's background refresh (guardSearchStatistics) never queues an ANALYZE behind the lock.
      await ensureSearchStatistics(engine);
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

    test('searchVector returns an incomplete pool within its walk and pool budgets', async () => {
      const metas: unknown[] = [];
      const { ms, outcome } = await underLock(fresh => fresh.searchVector(embedding, { onVectorPoolMeta: meta => { metas.push(meta); } }));
      expect(outcome, `searchVector after ${ms.toFixed(0)} ms`).toEqual({ value: [] });
      expect(metas).toEqual([expect.objectContaining({ underfilled: true, incomplete: true, reason: 'deadline' })]);
      expect(ms).toBeLessThan(13_000);
    }, 60_000);

    test('explainVectorSearch fails with 57014 at its 8 s attempt budget', async () => {
      const { ms, outcome } = await underLock(fresh => fresh.explainVectorSearch(embedding));
      expect(outcome, `explainVectorSearch after ${ms.toFixed(0)} ms`).toEqual({ code: '57014' });
      expect(ms).toBeGreaterThanOrEqual(7_500);
      expect(ms).toBeLessThan(11_000);
    }, 60_000);

    test('once the lock is gone a fresh engine finds the page', async () => {
      const fresh = new PostgresEngine();
      await fresh.connect({ database_url: databaseUrl, poolSize: 2 });
      try {
        expect((await fresh.searchVector(embedding)).map(hit => hit.slug)).toEqual(['notes/alpha']);
        expect(await fresh.explainVectorSearch(embedding)).toHaveProperty('Plan');
      } finally {
        await fresh.disconnect();
      }
    }, 60_000);
  });
}
