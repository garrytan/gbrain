/**
 * #4880 — the contextual re-embed handler must release its synopsis rate
 * lease on Postgres, where a BIGSERIAL `RETURNING id` arrives as a native
 * BigInt (postgres.js `types: { bigint: postgres.BigInt }`). A strict
 * `typeof lease === 'number'` guard never released it and every slot idled
 * to its TTL. PGLite parses safe-range int8 to Number, so only a fake engine
 * reproduces the shape.
 *
 * #5276 — with expected_source_id the handler resolves the page in that
 * source only. A same-slug page elsewhere must neither shadow it nor be
 * re-embedded when the expected source lacks the page (PGLite fixture).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { makeContextualReindexHandler } from '../src/core/minions/handlers/contextual-reindex-per-chunk.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ReembedPageResult } from '../src/core/contextual-retrieval-service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

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
  test('uses expected_source_id to resolve a duplicate slug in its intended source', async () => {
    const getPageCalls: Array<{ slug: string; sourceId?: string }> = [];
    const engine = {
      async getPage(slug: string, opts?: { sourceId?: string }) {
        getPageCalls.push({ slug, sourceId: opts?.sourceId });
        if (opts?.sourceId === 'source-a') return { source_id: 'source-a' };
        if (opts?.sourceId === 'source-b') return { source_id: 'source-b' };
        return null;
      },
      async getConfig() { return null; },
    };
    let reembedSourceId: string | undefined;
    const handler = makeContextualReindexHandler({
      engine: engine as never,
      reembedPage: async (args) => {
        reembedSourceId = args.sourceId;
        return SUCCESS;
      },
    });

    await handler({
      id: 43,
      data: { page_slug: 'changelog', expected_source_id: 'source-a' },
      signal: new AbortController().signal,
    } as never);

    expect(getPageCalls).toEqual([{ slug: 'changelog', sourceId: 'source-a' }]);
    expect(reembedSourceId).toBe('source-a');
  });

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

describe('contextual_reindex_per_chunk expected_source_id on a real engine (#5276)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('acme-example','acme-example') ON CONFLICT DO NOTHING");
  });

  const page = (marker: string) => ({ type: 'note' as const, title: 'Changelog', compiled_truth: `${marker} prose`, timeline: '', frontmatter: {} });

  async function snapshot(sourceId: string) {
    const rows = await engine.executeRaw<{ compiled_truth: string; updated_at: string }>(
      'SELECT compiled_truth, updated_at::text AS updated_at FROM pages WHERE slug = $1 AND source_id = $2',
      ['notes/changelog', sourceId],
    );
    return rows[0];
  }

  test('a same-slug page in default does not shadow the expected source; the lease is taken and released', async () => {
    await engine.putPage('notes/changelog', page('default-marker'), { sourceId: 'default' });
    await engine.putPage('notes/changelog', page('acme-marker'), { sourceId: 'acme-example' });
    const [job] = await engine.executeRaw<{ id: number }>(
      "INSERT INTO minion_jobs (name, submission_authority) VALUES ('test-lease-owner', '{}'::jsonb) RETURNING id",
    );
    const reembedded: string[] = [];
    const handler = makeContextualReindexHandler({
      engine,
      reembedPage: async (args) => {
        reembedded.push(args.sourceId);
        const lease = await args.acquireSynopsisLease!();
        await args.releaseSynopsisLease!(lease);
        return SUCCESS;
      },
    });

    const result = await handler({
      id: job!.id,
      data: { page_slug: 'notes/changelog', expected_source_id: 'acme-example' },
      signal: new AbortController().signal,
    } as never);

    expect(result).toEqual({ ok: true, mode_applied: 'per_chunk_synopsis', chunks_embedded: 1 });
    expect(reembedded).toEqual(['acme-example']);
    expect(await engine.executeRaw('SELECT id FROM subagent_rate_leases')).toEqual([]);
  });

  test('a page missing from the expected source fails the job and never touches the other source', async () => {
    await engine.putPage('notes/changelog', page('default-marker'), { sourceId: 'default' });
    const before = await snapshot('default');
    let reembedCalls = 0;
    const handler = makeContextualReindexHandler({
      engine,
      reembedPage: async () => { reembedCalls++; return SUCCESS; },
    });

    let message = '';
    try {
      await handler({
        id: 44,
        data: { page_slug: 'notes/changelog', expected_source_id: 'acme-example' },
        signal: new AbortController().signal,
      } as never);
    } catch (err) {
      expect((err as Error).name).toBe('UnrecoverableError');
      message = (err as Error).message;
    }

    expect(message).toBe(
      "Page not found for slug 'notes/changelog' in its expected source. " +
        'The payload is stale or the page was deleted; nothing was re-embedded.',
    );
    expect(reembedCalls).toBe(0);
    expect(await snapshot('default')).toEqual(before);
    expect(await engine.executeRaw('SELECT id FROM subagent_rate_leases')).toEqual([]);
  });

  test('control: without expected_source_id the legacy default-then-sources walk still resolves', async () => {
    await engine.putPage('notes/changelog', page('acme-marker'), { sourceId: 'acme-example' });
    const reembedded: string[] = [];
    const handler = makeContextualReindexHandler({
      engine,
      reembedPage: async (args) => { reembedded.push(args.sourceId); return SUCCESS; },
    });

    await handler({ id: 45, data: { page_slug: 'notes/changelog' }, signal: new AbortController().signal } as never);

    expect(reembedded).toEqual(['acme-example']);
  });
});
