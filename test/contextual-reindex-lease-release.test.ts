/**
 * #4880 — the contextual re-embed handler must release its synopsis rate
 * lease on Postgres, where a BIGSERIAL `RETURNING id` arrives as a native
 * BigInt (postgres.js `types: { bigint: postgres.BigInt }`). A strict
 * `typeof lease === 'number'` guard never released it and every slot idled
 * to its TTL. PGLite parses safe-range int8 to Number, so only a fake engine
 * reproduces the shape.
 */
import { describe, expect, test } from 'bun:test';
import { makeContextualReindexHandler } from '../src/core/minions/handlers/contextual-reindex-per-chunk.ts';
import type { ReembedPageResult } from '../src/core/contextual-retrieval-service.ts';

type Call = { sql: string; params?: unknown[] };
const RELEASE_SQL = 'DELETE FROM subagent_rate_leases WHERE id = $1';

/** Answers acquireLease's transaction the way Postgres does (bigint id). */
function fakeEngine(calls: Call[]) {
  const engine = {
    async getPage() { return { source_id: 'default' }; },
    async getConfig() { return null; },
    async transaction<T>(fn: (tx: unknown) => Promise<T>) { return fn(engine); },
    async executeRaw(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql.includes('count(*)')) return [{ count: '0' }];
      if (sql.includes('RETURNING id')) return [{ id: 26016n }];
      return [];
    },
  };
  return engine;
}

const SUCCESS: ReembedPageResult = {
  kind: 'success',
  mode_applied: 'per_chunk_synopsis',
  chunks_embedded: 1,
  corpus_generation: 'test-generation',
};

const JOB = { id: 42, data: { page_slug: 'wiki/example' }, signal: new AbortController().signal } as never;

describe('contextual_reindex_per_chunk synopsis lease release', () => {
  test('releases the lease acquired through a Postgres-shaped RETURNING id (native BigInt)', async () => {
    const calls: Call[] = [];
    const handler = makeContextualReindexHandler({
      engine: fakeEngine(calls) as never,
      reembedPage: async (args) => {
        const lease = await args.acquireSynopsisLease!();
        await args.releaseSynopsisLease!(lease);
        return SUCCESS;
      },
    });
    await handler(JOB);
    expect(calls.filter(c => c.sql === RELEASE_SQL)).toEqual([{ sql: RELEASE_SQL, params: [26016] }]);
  });

  test('release is not gated on typeof number (the acquire seam owns the coercion)', async () => {
    const calls: Call[] = [];
    const handler = makeContextualReindexHandler({
      engine: fakeEngine(calls) as never,
      reembedPage: async (args) => {
        await args.releaseSynopsisLease!(26016n);
        return SUCCESS;
      },
    });
    await handler(JOB);
    const releases = calls.filter(c => c.sql === RELEASE_SQL);
    expect(releases.length).toBe(1);
    expect(Number(releases[0]!.params![0])).toBe(26016);
  });

  test('a null lease (never acquired) issues no DELETE (#4880 regression: release is skipped, not misfired)', async () => {
    const calls: Call[] = [];
    const handler = makeContextualReindexHandler({
      engine: fakeEngine(calls) as never,
      reembedPage: async (args) => {
        await args.releaseSynopsisLease!(null as never);
        await args.releaseSynopsisLease!(undefined as never);
        return SUCCESS;
      },
    });
    await handler(JOB);
    expect(calls.filter(c => c.sql === RELEASE_SQL)).toEqual([]);
  });
});
