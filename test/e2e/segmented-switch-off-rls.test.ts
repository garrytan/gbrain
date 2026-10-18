/**
 * Segmented page tables while segmented storage is off (Wave B PR 2, fix lane E: E1).
 *
 * 1. Protects: "while pages.segmented_storage is off nothing user-visible changes" for a restricted Postgres role
 *    (NOLOGIN, NOBYPASSRLS, not the owner) holding the pre-Wave-B grant set (SELECT on every table except the
 *    segment tables). Postgres checks the privilege of every relation a statement names, matched or not, so a chunk
 *    read that names page_body_manifest fails with 42501 on a brain that has no segmented page. With no segmented
 *    chunk row the role can see, every search arm, the chunk windows, get_chunks and get_page run without the grant,
 *    as a pooled session role and under SET LOCAL ROLE in a transaction, and read only the role's source. A page
 *    segmented in another source changes nothing for it. Once a page of its own source is segmented the documented
 *    grant is required (42501 without it), and with the docs/ENGINES.md manifest policy the role still sees only its
 *    source's manifest rows.
 * 2. Fails when: a read path a restricted role runs names a segment table although the role can see no segmented
 *    chunk row, or a role that can see one reads its chunks without the manifest.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { segmentRegions } from '../../src/core/search/dedup.ts';
import { resolveFrozenHits } from '../../src/core/search/evidence-delivery.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { vector } from '../helpers/search-query-contract.ts';
import { hasDatabase, setupLegacyEmbeddingDB, teardownDB } from './helpers.ts';

const READER = 'gbrain_seg_off_reader_' + randomUUID().replaceAll('-', '').slice(0, 12);
const SEGMENT_TABLES = ['page_body_manifest', 'page_body_staging_parts', 'page_body_staging_texts', 'page_body_stagings', 'page_segment_texts', 'page_view_digests'];
const SCOPE = "current_setting('app.scopes', true) = '*' OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ','))";
const sourcesOf = (rows: ReadonlyArray<{ source_id?: unknown }>) => [...new Set(rows.map(r => String(r.source_id)))].sort();

type Arm = (e: BrainEngine) => Promise<string[]>;

(hasDatabase() ? describe : describe.skip)('segment tables while segmented storage is off (restricted role)', () => {
  let engine: PostgresEngine;
  let reader: PostgresEngine;
  const ids: Record<string, number> = {};
  let granted: string[] = [];

  const ctxOf = (e: BrainEngine): OperationContext => ({ engine: e, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} },
    dryRun: false, remote: true, sourceId: 'src-a' }) as unknown as OperationContext;
  const op = (name: string, params: Record<string, unknown>) => operations.find(o => o.name === name)!.handler;
  const run = (e: BrainEngine, name: string, params: Record<string, unknown>) => op(name, params)(ctxOf(e), params) as Promise<Record<string, unknown>>;

  /** Arms that only read; each returns the sources it saw. */
  const engineArms: Record<string, Arm> = {
    keyword: async e => sourcesOf(await e.searchKeyword('ledgerneedle', { sourceId: 'src-a' })),
    keywordChunks: async e => sourcesOf(await e.searchKeywordChunks('ledgerneedle', { sourceId: 'src-a' })),
    titles: async e => sourcesOf(await e.searchTitles('ledger', { sourceId: 'src-a' })),
    vector: async e => { await e.searchVector(vector, { sourceId: 'src-a' }); return sourcesOf(await e.searchVector(vector, { sourceId: 'src-a' })); },
    windows: async e => sourcesOf(await e.getChunkWindows([ids['src-a']!, ids['src-b']!].map(page_id => ({ page_id, from_index: 0, to_index: 3, priority: 0 })),
      { chunkSources: ['compiled_truth', 'timeline'], maxRows: 20 })),
    chunks: async e => (await e.getChunks('notes/ledger', { sourceId: 'src-a', includeUnsealed: true })).length > 0 ? ['src-a'] : [],
    chunkPage: async e => (await e.getChunkPage('notes/ledger', { sourceId: 'src-a', fromIndex: 0, limit: 10 })).chunks.length > 0 ? ['src-a'] : [],
    fanout: async e => sourcesOf(await e.relationalFanout(['notes/ledger'], { sourceId: 'src-a', depth: 1 } as never)),
    regions: async e => {
      const hits = [1, 2, 3].map(i => ({ slug: 'notes/ledger', source_id: 'src-a', chunk_id: i, page_id: ids['src-a'] }) as unknown as SearchResult);
      return (await segmentRegions(e, hits)).size === 0 ? ['src-a'] : [];
    },
    frozen: async e => sourcesOf((await resolveFrozenHits(e, ['src-a', 'src-b'].map(source_id => ({ source_id, slug: 'notes/ledger', chunk_id: 0 })), {})).rows),
  };
  /** Operations; their best-effort last-retrieved write-back needs a writable role, so they run as the session role only. */
  const opArms: Record<string, Arm> = {
    get_page_none: async e => [String((await run(e, 'get_page', { slug: 'notes/ledger', source_id: 'src-a', body: 'none' })).source_id ?? 'src-a')],
    get_page_full: async e => [String((await run(e, 'get_page', { slug: 'notes/ledger', source_id: 'src-a' })).source_id ?? 'src-a')],
    get_page_auto: async e => [String((await run(e, 'get_page', { slug: 'notes/ledger', source_id: 'src-a', body: 'auto' })).source_id ?? 'src-a')],
    get_chunks: async e => { await run(e, 'get_chunks', { slug: 'notes/ledger' }); return ['src-a']; },
    search: async e => sourcesOf(await run(e, 'search', { query: 'ledgerneedle' }) as never),
    explain_target: async e => { await run(e, 'search', { query: 'ledgerneedle', explain_target: 'notes/ledger' }); return ['src-a']; },
    query: async e => sourcesOf(await run(e, 'query', { query: 'ledgerneedle', expand: false }) as never),
  };

  async function asSessionRole(arms: Record<string, Arm>): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [name, arm] of Object.entries(arms)) out[name] = await arm(reader).catch((e: { code?: string }) => 'error ' + e.code);
    return out;
  }
  async function asLocalRole(arms: Record<string, Arm>): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [name, arm] of Object.entries(arms)) {
      out[name] = await engine.transaction(async tx => {
        await tx.executeRaw('SET LOCAL ROLE ' + READER);
        await tx.executeRaw("SELECT set_config('app.scopes', 'src-a', true)");
        return arm(tx);
      }).catch((e: { code?: string }) => 'error ' + e.code);
    }
    return out;
  }
  const allSrcA = (arms: Record<string, Arm>) => Object.fromEntries(Object.keys(arms).map(name => [name, ['src-a']]));

  beforeAll(async () => {
    engine = await setupLegacyEmbeddingDB();
    for (const id of ['src-a', 'src-b']) {
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
      for (const slug of ['notes/ledger', 'notes/ledger-peer']) {
        await engine.putPage(slug, { type: 'note', title: 'Ledger ' + id, compiled_truth: 'ledgerneedle ' + id + ' see [[notes/ledger-peer]]' }, { sourceId: id });
        await installFixtureChunks(engine, slug, [0, 1].map(chunk_index => ({ chunk_index, chunk_source: 'compiled_truth' as const, chunk_text: 'ledgerneedle ' + id + ' part ' + chunk_index, embedding: vector })), { sourceId: id });
      }
      await engine.addLink('notes/ledger', 'notes/ledger-peer', '', 'mentions', 'markdown', undefined, undefined, { fromSourceId: id, toSourceId: id } as never).catch(() => undefined);
      ids[id] = Number((await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug = 'notes/ledger' AND source_id = $1", [id]))[0]!.id);
    }
    // Enough pages outside src-a that its vector search takes the source-scope scan.
    for (let i = 0; i < 12; i++) {
      await engine.putPage('notes/filler-' + i, { type: 'note', title: 'Filler ' + i, compiled_truth: 'filler ' + i }, { sourceId: 'src-b' });
      await installFixtureChunks(engine, 'notes/filler-' + i, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'filler ' + i, embedding: vector }], { sourceId: 'src-b' });
    }
    await engine.executeRaw('ANALYZE pages');
    await engine.executeRaw('ANALYZE content_chunks');

    await engine.executeRaw('CREATE ROLE ' + READER + ' NOLOGIN NOSUPERUSER NOBYPASSRLS');
    await engine.executeRaw('GRANT USAGE ON SCHEMA public TO ' + READER);
    granted = (await engine.executeRaw<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).map(r => r.t).filter(t => !SEGMENT_TABLES.includes(t));
    await engine.executeRaw('GRANT SELECT ON ' + granted.join(', ') + ' TO ' + READER);
    for (const t of granted) {
      const using = t === 'pages' ? SCOPE : t === 'content_chunks' ? "current_setting('app.scopes', true) = '*' OR EXISTS (SELECT 1 FROM pages p WHERE p.id = page_id)" : 'true';
      await engine.executeRaw('CREATE POLICY ' + READER + '_read ON ' + t + ' FOR SELECT TO ' + READER + ' USING (' + using + ')');
    }
    reader = new PostgresEngine();
    await reader.connect({ database_url: process.env.DATABASE_URL!, poolSize: 1 });
    await reader.executeRaw('SET ROLE ' + READER);
    await reader.executeRaw("SET app.scopes = 'src-a'");
  }, 300_000);

  afterAll(async () => {
    await reader?.disconnect();
    if (engine) {
      for (const t of [...granted, 'page_body_manifest']) await engine.executeRaw('DROP POLICY IF EXISTS ' + READER + '_read ON ' + t);
      await engine.executeRaw('DROP OWNED BY ' + READER).catch(() => undefined);
      await engine.executeRaw('DROP ROLE IF EXISTS ' + READER);
    }
    await teardownDB();
  });

  test('E1: with no segmented page, a role without the manifest grant runs every search arm, the chunk windows, get_chunks and get_page', async () => {
    expect(await engine.executeRaw("SELECT count(*)::int AS n FROM pages WHERE body_storage = 'segmented'")).toEqual([{ n: 0 }]);
    expect(await engine.getConfig('pages.segmented_storage')).toBeNull();
    expect({ session: await asSessionRole({ ...engineArms, ...opArms }), local: await asLocalRole(engineArms) })
      .toEqual({ session: allSrcA({ ...engineArms, ...opArms }), local: allSrcA(engineArms) });
  }, 120_000);

  test('E1: a page segmented in another source changes nothing; one in its own source requires the documented grant, and the policy hides the other source', async () => {
    await engine.setConfig('pages.segmented_storage', 'on');
    const segment = async (id: string, seed: number) => {
      const content = conversationPage(2 * 1024 * 1024, { seed, title: 'Ledger big ' + id, needles: [{ at: 0.5, word: 'ledgerneedle' }] });
      expect((await importFromContent(engine, 'notes/big-ledger', content, { noEmbed: true, sourceId: id })).status).toBe('imported');
      expect(await engine.executeRaw("SELECT body_storage FROM pages WHERE slug = 'notes/big-ledger' AND source_id = $1", [id])).toEqual([{ body_storage: 'segmented' }]);
    };
    await segment('src-b', 81);
    expect({ session: await asSessionRole(engineArms), local: await asLocalRole(engineArms) }).toEqual({ session: allSrcA(engineArms), local: allSrcA(engineArms) });

    await segment('src-a', 82);
    expect(await asSessionRole({ titles: engineArms.titles!, windows: engineArms.windows! })).toEqual({ titles: 'error 42501', windows: 'error 42501' });
    expect(await asLocalRole({ titles: engineArms.titles! })).toEqual({ titles: 'error 42501' });

    await engine.executeRaw('GRANT SELECT ON page_body_manifest TO ' + READER);
    await engine.executeRaw('CREATE POLICY ' + READER + '_read ON page_body_manifest FOR SELECT TO ' + READER + ' USING (' + SCOPE + ')');
    const manifestSources = async (e: BrainEngine) => sourcesOf(await e.executeRaw<{ source_id: string }>('SELECT DISTINCT source_id FROM page_body_manifest'));
    const arms = { ...engineArms, manifest: manifestSources };
    expect({ session: await asSessionRole(arms), local: await asLocalRole(arms) }).toEqual({ session: allSrcA(arms), local: allSrcA(arms) });
    expect(await manifestSources(engine)).toEqual(['src-a', 'src-b']);
  }, 300_000);
});
