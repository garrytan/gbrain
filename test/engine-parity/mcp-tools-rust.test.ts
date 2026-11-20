/**
 * BrainEngine parity: MCP tools that a Rust brain refused with no owner (lane 12's serve-http route table), called
 * through `dispatchToolCall` as a trusted local stdio caller, on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each tool answers the same on PGLite, Postgres and Rust, or the Rust arm stops on a named refusal.
 *    get_job_stats raises the `no_worker` notice with the waiting count of its queue; cache_stats refuses on Rust as
 *    `query_cache_unavailable` (the store keeps no query_cache table) and never answers zero rows there. schema_stats
 *    counts live pages per source and type (archived sources included, soft-deleted pages not, an empty type as
 *    untyped) and finds the pack prefixes no live page matches, with SQL LIKE meaning for `%`, `_` and `\`.
 *    get_status_snapshot counts, per source, its live pages, their chunks and the chunks with no vector.
 *  - Regression: a raw-SQL read on the tool path that a Rust brain refuses, or a fail-open catch that hides the refusal
 *    and answers as if the table were empty.
 *  - Why existing coverage misses it: test/quarantine-cache-ops.test.ts and the jobs op tests run on PGLite only.
 *  - Seam: dispatchToolCall, the MCP tools/call path both transports share; results are parsed from its text block.
 */
import { describe, expect } from 'bun:test';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { ALL_SOURCES } from '../../src/core/source-id.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { NoticeLedger } from '../../src/core/notice-ledger.ts';
import { archiveSource, basisEmbedding, createSource, parityArms } from './harness.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const LOCAL = { remote: false, transport: 'stdio' as const, sourceId: 'default' };

interface ToolAnswer { error: string | null; body: Record<string, unknown> | null; notices: string[] }

/** One tools/call: the parsed JSON body, or the error code of an isError result, and the notice codes. */
async function call(engine: Parameters<typeof dispatchToolCall>[0], name: string, params: Record<string, unknown> = {}, scope: { sourceId?: string } = LOCAL): Promise<ToolAnswer> {
  // A fresh ledger per call: the process ledger admits a notice once per audience, so a later arm would not see it.
  const res = await dispatchToolCall(engine, name, params, { ...LOCAL, ...scope, noticeLedger: new NoticeLedger() });
  // A success renders each notice as a text block beside the body; the body is the block that is a JSON object.
  const blocks = res.content.map(c => (c as { text?: string }).text ?? '');
  const text = blocks.find(b => b.trimStart().startsWith('{')) ?? blocks.join('\n');
  const meta = (res as { _meta?: { gbrain_notices?: Array<{ code?: string }> } })._meta;
  const notices = (meta?.gbrain_notices ?? []).map(n => String(n.code));
  if (res.isError) {
    let code = text;
    try { const parsed = JSON.parse(text) as { error?: string; code?: string; detail?: string }; code = `${parsed.code ?? parsed.error}${parsed.detail ? ` ${parsed.detail}` : ''}`; } catch { /* plain text */ }
    return { error: code, body: null, notices };
  }
  return { error: null, body: JSON.parse(text) as Record<string, unknown>, notices };
}

describe('engine parity: MCP tools a Rust brain refused', () => {
  parityTest('get_job_stats names the waiting jobs of a queue no worker serves',
    { methods: ['listWaitingByQueue'] }, async (engine) => {
      const queue = new MinionQueue(engine);
      await queue.add('sync', { n: 1 }, { queue: 'lane-q' });
      await queue.add('sync', { n: 2 }, { queue: 'lane-q' });
      await queue.add('sync', { n: 3 }, { queue: 'other-q' });
      const answer = await call(engine, 'get_job_stats', { queue: 'lane-q' });
      expect(answer.error).toBeNull();
      expect(answer.body?.no_worker).toBe(true);
      expect(answer.notices).toContain('no_worker');
      return { no_worker: answer.body?.no_worker, notices: answer.notices };
    });

  parityTest('cache_stats counts the query cache on SQL brains and refuses by name on Rust, never as zero rows',
    { methods: ['readQueryCacheStats'] }, async (engine, backend) => {
      const answer = await call(engine, 'cache_stats');
      if (backend === 'rust') {
        expect(answer.body).toBeNull();
        expect(answer.error).toContain('engine_capability_missing');
        expect(answer.error).toContain('query_cache_unavailable');
        // The harness wants the Rust arm to end on the typed refusal the member raised.
        await engine.readQueryCacheStats();
      }
      expect(answer.error).toBeNull();
      return { total_rows: answer.body?.total_rows, total_hits: answer.body?.total_hits };
    });

  parityTest('schema_stats counts live pages per source and type and names the dead pack prefixes',
    { methods: ['countLivePagesBySourceType', 'countLivePagesBySlugPrefixes'] }, async (engine, backend) => {
      await createSource(engine, backend, 'side');
      await createSource(engine, backend, 'arch');
      const put = (slug: string, type: string, sourceId = 'default') =>
        engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `About ${slug}.` }, { sourceId });
      await put('people/alice-example', 'person');
      await put('people/bob-example', 'person');
      await put('companies/acme-example', 'company');
      await put('notes/gone', 'note');
      await engine.softDeletePage('notes/gone');
      await put('people/carol-example', 'person', 'side');
      await put('Zeta/upper', 'concept', 'side');
      await put('people/old-example', 'person', 'arch');
      await archiveSource(engine, backend, 'arch');
      // The __all__ sentinel: a trusted local caller reads the whole brain.
      const whole = await call(engine, 'schema_stats', {}, { sourceId: ALL_SOURCES });
      expect(whole.error).toBeNull();
      const perSource = (whole.body?.per_source ?? []) as Array<{ source_id: string; total_pages: number; by_type: unknown }>;
      expect(perSource.map(r => r.source_id)).toEqual(['arch', 'default', 'side']);
      const side = await call(engine, 'schema_stats', {}, { sourceId: 'side' });
      expect(side.error).toBeNull();
      const deadPrefixes = (whole.body?.dead_prefixes ?? []) as Array<{ type: string; prefix: string }>;
      return {
        aggregate: whole.body?.aggregate,
        per_source: perSource,
        pack_identity: whole.body?.pack_identity,
        dead_prefixes: deadPrefixes,
        side: side.body?.aggregate,
      };
    });

  parityTest('the live-page slug prefix counts keep SQL LIKE wildcards and escapes, in prefix order',
    { methods: ['countLivePagesBySlugPrefixes', 'countLivePagesBySourceType'] }, async (engine, backend) => {
      await createSource(engine, backend, 'side');
      const put = (slug: string, type: string, sourceId = 'default') =>
        engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `About ${slug}.` }, { sourceId });
      await put('people/alice-example', 'person');
      await put('peoplex/odd', 'person');
      await put('notes/a', 'note');
      await put('notes/b', 'note', 'side');
      await put('notes/gone', 'note');
      await engine.softDeletePage('notes/gone');
      const prefixes = ['people/', 'people_', 'people\\_', 'notes/', 'missing/', '%', 'notes/g'];
      return {
        all: await engine.countLivePagesBySlugPrefixes(prefixes),
        side: await engine.countLivePagesBySlugPrefixes(prefixes, { sourceIds: ['side'] }),
        none: await engine.countLivePagesBySlugPrefixes([]),
        types: await engine.countLivePagesBySourceType({ sourceIds: ['default', 'side'] }),
      };
    });

  parityTest('get_status_snapshot counts each source\'s live pages, their chunks and the chunks with no vector',
    { methods: ['countSourcePagesAndChunks'] }, async (engine, backend) => {
      await createSource(engine, backend, 'side');
      await createSource(engine, backend, 'empty');
      const note = (title: string) => ({ type: 'note' as const, title, compiled_truth: `${title} body`, timeline: '' });
      await seedPage(engine, { slug: 'notes/a', input: note('a'),
        chunks: [chunk(0, 'a one', { embedding: basisEmbedding(1) }), chunk(1, 'a two')] });
      await seedPage(engine, { slug: 'notes/b', input: note('b'), chunks: [chunk(0, 'b one', { embedding: basisEmbedding(2) })] });
      await seedPage(engine, { slug: 'notes/gone', input: note('gone'), chunks: [chunk(0, 'gone one')] });
      await engine.softDeletePage('notes/gone');
      await seedPage(engine, { slug: 'notes/c', input: note('c'), chunks: [chunk(0, 'c one'), chunk(1, 'c two')] }, { sourceId: 'side' });
      const answer = await call(engine, 'get_status_snapshot');
      expect(answer.error).toBeNull();
      const sync = answer.body?.sync as { sources: Array<Record<string, unknown>>; embedding_column: string };
      const counts = sync.sources.map(s => ({ source_id: s.source_id, pages: s.pages, chunks_total: s.chunks_total,
        chunks_unembedded: s.chunks_unembedded, embedding_coverage_pct: s.embedding_coverage_pct }));
      expect(counts.map(c => [c.source_id, c.pages, c.chunks_total, c.chunks_unembedded])).toEqual([
        ['default', 2, 3, 1], ['empty', 0, 0, 0], ['side', 1, 2, 2],
      ]);
      const body = answer.body as { cycle: unknown; queue: unknown; workers: unknown };
      return { counts, embedding_column: sync.embedding_column, cycle: body.cycle, queue: body.queue, workers: body.workers };
    });
});
