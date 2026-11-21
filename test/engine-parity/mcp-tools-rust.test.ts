/**
 * BrainEngine parity: MCP tools that a Rust brain refused with no owner (lane 12's serve-http route table), called
 * through `dispatchToolCall` as a trusted local stdio caller, on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each tool answers the same on PGLite, Postgres and Rust, or the Rust arm stops on a named refusal.
 *    get_job_stats raises the `no_worker` notice with the waiting count of its queue; cache_stats answers the brain's
 *    cache knobs and an empty cache (no engine stores a cache row while semanticResultCacheAvailable() is false). schema_stats
 *    counts live pages per source and type (archived sources included, soft-deleted pages not, an empty type as
 *    untyped) and finds the pack prefixes no live page matches, with SQL LIKE meaning for `%`, `_` and `\`.
 *    get_status_snapshot counts, per source, its live pages, their chunks and the chunks with no vector. put_pages
 *    writes a batch and reads it back by its request_id alone, page by page in index order, with its links state.
 *    rank_entities lists title-prefixed person duplicates; a remote world-only caller is never named a private one.
 *  - Regression: a raw-SQL read on the tool path that a Rust brain refuses, or a fail-open catch that hides the refusal
 *    and answers as if the table were empty.
 *  - Why existing coverage misses it: test/quarantine-cache-ops.test.ts, test/rank-entities.test.ts and the jobs op
 *    tests run on PGLite only.
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
import { withEnv } from '../helpers/with-env.ts';
import { FILE_DRIFT_MESSAGE } from '../../src/core/persistence/drift-conflicts.ts';
import { ENTITY_NAMES_REFERENCES_KEY } from '../../src/core/entity-references-config.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { parityTest } = parityArms(testBackends());

const LOCAL = { remote: false, transport: 'stdio' as const, sourceId: 'default' };

/** Runs `fn` under a fresh GBRAIN_HOME, so no host id or worktree binding from this machine reaches the trusted path. */
async function inFreshHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-conflicts-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

interface ToolAnswer { error: string | null; body: Record<string, unknown> | null; notices: string[] }

/** One tools/call: the parsed JSON body, or the error code of an isError result, and the notice codes. */
async function call(engine: Parameters<typeof dispatchToolCall>[0], name: string, params: Record<string, unknown> = {}, scope: { sourceId?: string; remote?: boolean } = LOCAL): Promise<ToolAnswer> {
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

  parityTest('cache_stats answers the brain cache knobs and an empty cache on every engine',
    { methods: ['readQueryCacheStats'] }, async (engine) => {
      await engine.setConfig('search.cache.ttl_seconds', '120');
      const answer = await call(engine, 'cache_stats');
      expect(answer.error).toBeNull();
      expect(answer.body).toEqual({
        schema_version: 1, enabled: false, similarity_threshold: 0.92, ttl_seconds: 120,
        total_rows: 0, total_hits: 0, fresh_rows: 0, stale_rows: 0,
      });
      return answer.body;
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

  parityTest('put_pages writes a batch, then reads it back by its request_id alone',
    { methods: ['insertWriteRequestGroup', 'readWriteRequests', 'readLinksEffectStates', 'requeueBatchLinksEffects'] }, async (engine) => {
      const batchId = '6f1c2a4e-0b7d-4c1e-9a55-3d2f8e7b6a10';
      const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
      const pages = [
        { slug: 'notes/batch-b', content: page('B', 'Second page.') },
        { slug: 'notes/batch-a', content: page('A', 'First page.') },
        { slug: 'notes/batch-b', content: page('B', 'Second page.') },
      ];
      const view = (body: Record<string, unknown> | null) => {
        const b = body as { state: string; counts: unknown; links: { state: string }; pages: Array<Record<string, unknown>> };
        return { state: b.state, counts: b.counts, links: b.links.state,
          pages: b.pages.map(p => ({ index: p.index, slug: p.slug, state: p.state, repeat_of: p.repeat_of ?? null, status: p.status ?? null })) };
      };
      const written = await call(engine, 'put_pages', { request_id: batchId, pages, wait_ms: 20000 });
      expect(written.error).toBeNull();
      const read = await call(engine, 'put_pages', { request_id: batchId });
      expect(read.error).toBeNull();
      expect(view(read.body).pages.map(p => p.slug)).toEqual(['notes/batch-b', 'notes/batch-a', 'notes/batch-b']);
      const unknown = await call(engine, 'put_pages', { request_id: '00000000-0000-4000-8000-000000000001' });
      return { written: view(written.body), read: view(read.body), unknown: unknown.error ?? view(unknown.body) };
    });

  parityTest('rank_entities lists title-prefixed person duplicates and names no private one to a world-only caller',
    { methods: ['listVisibleNameVariantCandidates', 'readVisibleVariantPages'] }, async (engine) => {
      const person = (slug: string, title: string, frontmatter: Record<string, unknown> = {}) =>
        engine.putPage(slug, { type: 'person', title, compiled_truth: 'Synthetic page.', timeline: '', frontmatter }, { sourceId: 'default' });
      await person('people/alice-zebraexample', 'Alice Zebraexample');
      await person('people/senator-zebraexample', 'Senator Zebraexample');
      await person('people/mayor-zebraexample', 'Mayor Zebraexample', { visibility: 'private' });
      for (const n of ['n1', 'n2', 'n3']) await engine.putPage(`notes/${n}`, { type: 'note', title: n, compiled_truth: 'Synthetic note.', timeline: '' }, { sourceId: 'default' });
      for (const [from, to] of [['notes/n1', 'people/alice-zebraexample'], ['notes/n2', 'people/alice-zebraexample'], ['notes/n3', 'people/alice-zebraexample'],
        ['notes/n1', 'people/senator-zebraexample'], ['notes/n2', 'people/senator-zebraexample'], ['notes/n1', 'people/mayor-zebraexample']]) {
        await engine.addLink(from!, to!, '', 'references', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' });
      }
      const ranked = (body: Record<string, unknown> | null) => (body?.entities as Array<{ slug: string; inbound: number; possible_duplicates?: Array<{ slug: string }> }>)
        .map(e => ({ slug: e.slug, inbound: e.inbound, duplicates: (e.possible_duplicates ?? []).map(d => d.slug) }));
      const local = await call(engine, 'rank_entities', { types: ['person'] });
      expect(local.error).toBeNull();
      expect(ranked(local.body)[0]).toEqual({ slug: 'people/alice-zebraexample', inbound: 3,
        duplicates: ['people/mayor-zebraexample', 'people/senator-zebraexample'] });
      const world = await call(engine, 'rank_entities', { types: ['person'] }, { remote: true });
      expect(world.error).toBeNull();
      expect(ranked(world.body)).toEqual([
        { slug: 'people/alice-zebraexample', inbound: 3, duplicates: ['people/senator-zebraexample'] },
        { slug: 'people/senator-zebraexample', inbound: 2, duplicates: ['people/alice-zebraexample'] },
      ]);
      expect(JSON.stringify(world.body)).not.toContain('mayor-zebraexample');
      return { local: ranked(local.body), world: ranked(world.body) };
    });

  parityTest('list_write_conflicts groups source_changed conflicts by slug and names no private page to a world-only caller',
    { methods: ['readDriftConflictBounds', 'countDriftConflicts', 'listDriftConflictGroups', 'readNewestCommittedReceipts', 'readPageSourcePaths',
      'insertWriteRequest', 'completeWriteRow', 'lockPersistenceCounters', 'readSourceMembership'] }, (engine) => inFreshHome(async () => {
      const page = (slug: string, frontmatter: Record<string, unknown> = {}) =>
        engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Synthetic page.', timeline: '', frontmatter }, { sourceId: 'default' });
      await page('notes/public-drift');
      await page('notes/private-drift', { visibility: 'private' });
      const source = await engine.readSourceMembership('default');
      const keys = ['principal:local_cli:parity-writer', 'brain'];
      const receipt = async (n: number, slug: string, state: 'conflict' | 'committed', kind = 'put_page') => {
        const id = `c0000000-0000-4000-8000-00000000000${n}`;
        await engine.lockPersistenceCounters(keys);
        const row = await engine.insertWriteRequest({
          principalKind: 'local_cli', principalId: 'parity-writer', requestId: id, operation: 'put_page', sourceId: 'default',
          sourceIncarnation: source!.incarnation, pageId: null, slug, worktreeId: null, topologyGeneration: null, digest: 'd'.repeat(64),
          intent: { kind, slug }, authority: { scopes: ['write'] }, intentBytes: 100, terminalReservation: 4096, targetKind: 'page',
          protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: keys, clientRequestId: null, state: 'queued', deferredRefreshId: null,
        });
        await engine.completeWriteRow({ id: row.id, state, outcome: null, errorCode: state === 'conflict' ? 'source_changed' : null,
          errorMessage: state === 'conflict' ? (n === 2 ? 'Another message.' : FILE_DRIFT_MESSAGE) : null, consumerVersion: 'parity', consumerHostId: null,
          errorDetail: null, resultBytes: 0, counterKeys: keys, intentBytes: 100, retainedBytes: 800, terminalReservation: 4096, probePurges: false });
      };
      await receipt(1, 'notes/public-drift', 'committed');
      await receipt(2, 'notes/public-drift', 'conflict', 'put_page');
      await receipt(3, 'notes/public-drift', 'conflict', 'tag');
      await receipt(4, 'notes/private-drift', 'conflict');
      await receipt(5, 'notes/ghost-drift', 'conflict');
      const view = (body: Record<string, unknown> | null) => {
        const b = body as { conflicts: Array<Record<string, unknown>>; totals: unknown; complete: boolean; next: unknown; next_actions: string[] };
        for (const c of b.conflicts) {
          expect(String(c.first_seen)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
          expect(String(c.last_seen)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
        }
        return { totals: b.totals, complete: b.complete, next: b.next, actions: b.next_actions.length,
          conflicts: b.conflicts.map(c => {
            const last = c.last_committed as { request_id?: string; completed_at: string } | null;
            return { slug: c.slug, receipts: c.receipts, drift: c.drift_receipts, producers: c.producers, last_conflict: c.last_conflict_request_id ?? null,
              source_path: c.source_path ?? null, still: c.still_present, committed: last ? { request_id: last.request_id ?? null, at: /Z$/.test(last.completed_at) } : null };
          }) };
      };
      const local = await call(engine, 'list_write_conflicts', {});
      expect(local.error).toBeNull();
      expect(view(local.body).conflicts.map(c => c.slug)).toEqual(['notes/ghost-drift', 'notes/private-drift', 'notes/public-drift']);
      const paged = await call(engine, 'list_write_conflicts', { limit: 1 });
      const next = (paged.body as { next: string | null }).next;
      expect(next).toBeString();
      const second = await call(engine, 'list_write_conflicts', { limit: 1, cursor: next });
      const world = await call(engine, 'list_write_conflicts', {}, { remote: true });
      expect(world.error).toBeNull();
      expect(view(world.body).conflicts.map(c => c.slug)).toEqual(['notes/public-drift']);
      expect(JSON.stringify(world.body)).not.toContain('private-drift');
      return { local: view(local.body), paged: view(paged.body).conflicts, second: view(second.body).conflicts, world: view(world.body) };
    }));

  // The names form reads the same card-projection variant lookup as the full card. The cases turn its reference counts
  // off: that read (mentions/referrers.ts) is raw SQL a Rust brain refuses, and it is not the read under test.
  type NameRow = { found: boolean; slug?: string; title?: string; lead?: string; match?: unknown; suggestions?: Array<{ slug: string }>; ambiguous?: boolean };
  const nameView = (a: ToolAnswer) => {
    const [r] = ((a.body as { results?: NameRow[] } | null)?.results ?? []);
    return { error: a.error, found: r?.found, slug: r?.slug ?? null, title: r?.title ?? null, lead: r?.lead ?? null, match: r?.match ?? null,
      suggestions: (r?.suggestions ?? []).map(x => x.slug), ambiguous: r?.ambiguous ?? false };
  };

  parityTest('entity resolves a name that has no page to its one name variant, for a local and a remote caller',
    { methods: ['listNameVariantCardCandidates'] }, async (engine) => {
      const put = (slug: string, type: string, title: string, body: string) =>
        engine.putPage(slug, { type, title, compiled_truth: body, timeline: '', frontmatter: {} }, { sourceId: 'default' });
      await engine.setConfig(ENTITY_NAMES_REFERENCES_KEY, 'off');
      await put('people/example-zelda', 'person', 'Example Zelda', 'Synthetic person.');
      await put('notes/zelda-meeting', 'note', 'Zelda meeting', 'Met Zelda Example about the plan.');
      const local = nameView(await call(engine, 'entity', { names: ['Zelda Example'] }));
      const world = nameView(await call(engine, 'entity', { names: ['Zelda Example'] }, { remote: true }));
      const want = { error: null, found: true, slug: 'people/example-zelda', title: 'Example Zelda', lead: 'Synthetic person.',
        match: { kind: 'reordered', via: 'Zelda Example' }, suggestions: [], ambiguous: false };
      expect(local).toEqual(want);
      expect(world).toEqual(want);
      return { local, world };
    });

  parityTest('entity follows a retired name variant to the live page it names',
    { methods: ['listNameVariantCardCandidates', 'readEntityCardRows'] }, async (engine) => {
      const put = (slug: string, title: string, frontmatter: Record<string, unknown> = {}) =>
        engine.putPage(slug, { type: 'person', title, compiled_truth: `${title} page.`, timeline: '', frontmatter }, { sourceId: 'default' });
      await engine.setConfig(ENTITY_NAMES_REFERENCES_KEY, 'off');
      await put('people/example-yara', 'Example Yara', { superseded_by: 'people/yq-current' });
      await put('people/yq-current', 'Yq Current');
      const local = nameView(await call(engine, 'entity', { names: ['Yara Example'] }));
      const world = nameView(await call(engine, 'entity', { names: ['Yara Example'] }, { remote: true }));
      const want = { error: null, found: true, slug: 'people/yq-current', title: 'Yq Current', lead: 'Yq Current page.',
        match: { kind: 'reordered', via: 'Yara Example' }, suggestions: [], ambiguous: false };
      expect(local).toEqual(want);
      expect(world).toEqual(want);
      return { local, world };
    });
});
