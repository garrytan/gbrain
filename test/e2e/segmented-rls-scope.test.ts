/**
 * Segmented page tables under Postgres RLS (Wave B PR 2, fix lane B: B1, B2).
 *
 * 1. Protects: the six segment tables (page_segment_texts, page_body_manifest, page_body_stagings,
 *    page_body_staging_parts, page_body_staging_texts, page_view_digests) get the RLS posture of `pages`: enabled on every schema replay, so a
 *    non-owner NOBYPASSRLS role with table SELECT and no policy reads none of their rows, as it reads no page. The
 *    operator recipe in docs/ENGINES.md (applied here verbatim) scopes them by source: a role scoped to src-a searches
 *    and reads its segmented page through every arm that probes the manifest, and never sees src-b's segment text,
 *    manifest rows or digests, with or without the GBRAIN_RLS_SCOPE_BINDING per-read binding. A role holding only the
 *    pre-Wave-B grant set (no page_body_manifest) fails title search with permission_denied, the behavior change the
 *    BEHAVIOR_CHANGES row names.
 * 2. Fails when: the schema replay stops re-enabling RLS on a segment table, the docs recipe is removed or stops
 *    isolating sources, a search arm reads a segment table the recipe does not cover, or the manifest stops being
 *    read by title search without the docs saying so.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { withEnv } from '../helpers/with-env.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const tag = randomUUID().replaceAll('-', '').slice(0, 12);
const OPEN = `gbrain_seg_rls_open_${tag}`;
const READER = `gbrain_seg_rls_reader_${tag}`;
const LEGACY = `gbrain_seg_rls_legacy_${tag}`;
const WRITER = `gbrain_seg_rls_writer_${tag}`;
const SOURCES = { 'src-a': 'alphaneedle', 'src-b': 'bravoneedle' } as const;
const slugOf = (id: string) => `notes/ledger-${id}`;
const PAGE_BODY_RLS_TABLES = ['page_body_manifest', 'page_body_staging_parts', 'page_body_staging_texts', 'page_body_stagings', 'page_segment_texts', 'page_view_digests'];
/** What a search and a body read touch besides the recipe's tables, opened to the reader. */
const SEARCH_SIDE_TABLES = ['config', 'timeline_entries'];

/** The SQL between the recipe markers in docs/ENGINES.md, for `role`. */
function docsRecipe(role: string): string {
  const doc = readFileSync(join(import.meta.dir, '../../docs/ENGINES.md'), 'utf8');
  const block = /<!-- gbrain:segmented-rls-recipe:begin[^>]*-->\s*\`\`\`sql\n([\s\S]*?)\`\`\`\s*<!-- gbrain:segmented-rls-recipe:end -->/.exec(doc);
  if (!block) throw new Error('docs/ENGINES.md has no segmented-rls-recipe block');
  return block[1]!.replaceAll('<reader-role>', role);
}

async function asRole<T>(engine: BrainEngine, role: string, fn: (tx: BrainEngine) => Promise<T>, scopes?: string): Promise<T> {
  return engine.transaction(async tx => {
    await tx.executeRaw(`SET LOCAL ROLE ${role}`);
    if (scopes !== undefined) await tx.executeRaw(`SELECT set_config('app.scopes', $1, true)`, [scopes]);
    return fn(tx);
  });
}

const sourcesOf = (hits: Array<{ source_id?: unknown }>) => [...new Set(hits.map(h => String(h.source_id)))].sort();

(hasDatabase() ? describe : describe.skip)('segmented page tables under RLS', () => {
  let engine: PostgresEngine;
  const pageIds: Record<string, number> = {};
  let policies: Array<{ name: string; table: string }> = [];
  let forced: string[] = [];

  beforeAll(async () => {
    engine = await setupDB();
    await engine.setConfig('pages.segmented_storage', 'on');
    for (const [id, needle] of Object.entries(SOURCES)) {
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
      const content = conversationPage(2 * 1024 * 1024, { seed: id === 'src-a' ? 71 : 72, title: `Ledger ${needle}`, needles: [{ at: 0.6, word: needle }] });
      expect((await importFromContent(engine, slugOf(id), content, { noEmbed: true, sourceId: id })).status).toBe('imported');
      const [row] = await engine.executeRaw<{ id: number; body_storage: string }>('SELECT id, body_storage FROM pages WHERE slug = $1 AND source_id = $2', [slugOf(id), id]);
      expect(row!.body_storage).toBe('segmented');
      pageIds[id] = row!.id;
      // A trusted read caches the page's read-view line count in page_view_digests.
      const ctx = { engine, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: id } as unknown as OperationContext;
      await operations.find(o => o.name === 'get_page')!.handler(ctx, { slug: slugOf(id), source_id: id, body: 'none' });
    }
    expect(Number((await engine.executeRaw<{ n: number }>('SELECT count(DISTINCT page_id)::int AS n FROM page_view_digests'))[0]!.n)).toBe(2);
    for (const role of [OPEN, READER, LEGACY]) {
      await engine.executeRaw(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${role}`);
    }
  }, 300_000);

  afterAll(async () => {
    if (engine) {
      for (const p of policies) await engine.executeRaw(`DROP POLICY IF EXISTS ${p.name} ON ${p.table}`);
      for (const t of forced) await engine.executeRaw(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      for (const role of [OPEN, READER, LEGACY, WRITER]) {
        await engine.executeRaw(`DROP OWNED BY ${role}`).catch(() => undefined);
        await engine.executeRaw(`DROP ROLE IF EXISTS ${role}`);
      }
      await engine.initSchema();
    }
    await teardownDB();
  });

  test('B1: every schema replay re-enables RLS on the segment tables, so a role with SELECT and no policy reads no segment row, as it reads no page', async () => {
    for (const t of PAGE_BODY_RLS_TABLES) await engine.executeRaw(`ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`);
    await engine.initSchema();
    const state = await engine.executeRaw<{ relname: string; relrowsecurity: boolean }>(
      'SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = \'r\' ORDER BY relname', [['pages', ...PAGE_BODY_RLS_TABLES]]);
    expect(state).toEqual(['pages', ...PAGE_BODY_RLS_TABLES].sort().map(relname => ({ relname, relrowsecurity: true })));

    await engine.executeRaw(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${OPEN}`);
    const counts = await asRole(engine, OPEN, async tx => {
      const out: Record<string, number> = {};
      for (const t of ['pages', ...PAGE_BODY_RLS_TABLES]) out[t] = Number((await tx.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n);
      return out;
    });
    expect(counts).toEqual(Object.fromEntries(['pages', ...PAGE_BODY_RLS_TABLES].map(t => [t, 0])));
    expect(Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_segment_texts'))[0]!.n)).toBeGreaterThan(0);
  }, 120_000);

  describe('the docs/ENGINES.md recipe', () => {
    beforeAll(async () => {
      await engine.executeRaw(`CREATE POLICY ${READER}_pages ON pages
        USING (current_setting('app.scopes', true) = '*' OR source_id = ANY(string_to_array(current_setting('app.scopes', true), ',')))`);
      policies.push({ name: `${READER}_pages`, table: 'pages' });
      const recipe = docsRecipe(READER);
      for (const m of recipe.matchAll(/CREATE POLICY (\w+) ON (\w+)/g)) policies.push({ name: m[1]!, table: m[2]! });
      forced = [...recipe.matchAll(/ALTER TABLE (\w+) FORCE ROW LEVEL SECURITY/g)].map(m => m[1]!);
      expect(policies.map(p => p.table)).toEqual(expect.arrayContaining([...PAGE_BODY_RLS_TABLES, 'content_chunks', 'sources']));
      await engine.executeRaw(recipe);
      // The recipe grants the page tables; the other tables a search reads open to the reader, so the recipe is the only
      // thing that filters page text.
      await engine.executeRaw(`GRANT SELECT ON ${SEARCH_SIDE_TABLES.join(', ')} TO ${READER}`);
      const covered = new Set(policies.map(p => p.table));
      for (const t of SEARCH_SIDE_TABLES.filter(t => !covered.has(t))) {
        await engine.executeRaw(`CREATE POLICY ${READER}_open ON ${t} FOR SELECT TO ${READER} USING (true)`);
        policies.push({ name: `${READER}_open`, table: t });
      }
    }, 120_000);

    test('B2: a role scoped to src-a searches and reads its segmented page and never sees src-b segment text', async () => {
      await withEnv({ GBRAIN_RLS_SCOPE_BINDING: undefined }, async () => {
        const seen = await asRole(engine, READER, async tx => ({
          alpha: sourcesOf(await tx.searchKeyword(SOURCES['src-a'])),
          bravo: sourcesOf(await tx.searchKeyword(SOURCES['src-b'])),
          alphaChunks: sourcesOf(await tx.searchKeywordChunks(SOURCES['src-a'])),
          bravoChunks: sourcesOf(await tx.searchKeywordChunks(SOURCES['src-b'])),
          titles: sourcesOf(await tx.searchTitles('ledger')),
          windows: (await tx.getChunkWindows(Object.values(pageIds).map(id => ({ page_id: id, from_index: 0, to_index: 3, priority: 0 })),
            { chunkSources: ['compiled_truth', 'timeline'], maxRows: 20 })).map(w => w.source_id).sort(),
          body: (await materializeSegmentedBody(tx, pageIds['src-a']!, 'src-a')).compiled_truth.includes(SOURCES['src-a']),
          rows: await tx.executeRaw<{ t: string; source_id: string }>(
            `SELECT 'texts' AS t, source_id FROM page_segment_texts UNION SELECT 'manifest', source_id FROM page_body_manifest
             UNION SELECT 'chunks', p.source_id FROM content_chunks c JOIN pages p ON p.id = c.page_id ORDER BY 1, 2`),
          bravoText: Number((await tx.executeRaw<{ n: number }>(
            `SELECT count(*)::int AS n FROM page_segment_texts WHERE position($1::bytea IN body) > 0`, [Buffer.from(SOURCES['src-b'])]))[0]!.n),
          bravoManifest: Number((await tx.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_body_manifest WHERE page_id = $1', [pageIds['src-b']]))[0]!.n),
          bravoChunkText: Number((await tx.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks WHERE position($1 IN chunk_text) > 0', [SOURCES['src-b']]))[0]!.n),
          digests: (await tx.executeRaw<{ page_id: number }>('SELECT DISTINCT page_id FROM page_view_digests')).map(r => Number(r.page_id)),
        }), 'src-a');
        expect(seen).toEqual({ alpha: ['src-a'], bravo: [], alphaChunks: ['src-a'], bravoChunks: [], titles: ['src-a'], windows: ['src-a'], body: true,
          rows: [{ t: 'chunks', source_id: 'src-a' }, { t: 'manifest', source_id: 'src-a' }, { t: 'texts', source_id: 'src-a' }], bravoText: 0, bravoManifest: 0, bravoChunkText: 0, digests: [pageIds['src-a']] });
        const owner = Number((await engine.executeRaw<{ n: number }>(
          `SELECT count(*)::int AS n FROM page_segment_texts WHERE position($1::bytea IN body) > 0`, [Buffer.from(SOURCES['src-b'])]))[0]!.n);
        expect(owner).toBeGreaterThan(0);
      });
    }, 120_000);

    test('B2: with the per-read binding, each request sees only the source it names', async () => {
      await withEnv({ GBRAIN_RLS_SCOPE_BINDING: '1' }, async () => {
        const seen = await asRole(engine, READER, async tx => ({
          alphaAsA: sourcesOf(await tx.searchKeyword(SOURCES['src-a'], { sourceId: 'src-a' })),
          bravoAsA: sourcesOf(await tx.searchKeyword(SOURCES['src-b'], { sourceId: 'src-a' })),
          bravoAsB: sourcesOf(await tx.searchKeyword(SOURCES['src-b'], { sourceId: 'src-b' })),
          titlesAsB: sourcesOf(await tx.searchTitles('ledger', { sourceId: 'src-b' })),
        }), '');
        expect(seen).toEqual({ alphaAsA: ['src-a'], bravoAsA: [], bravoAsB: ['src-b'], titlesAsB: ['src-b'] });
      });
    }, 120_000);

    test('B2: a role holding the pre-Wave-B grant set (no page_body_manifest) fails title search with permission_denied', async () => {
      await engine.executeRaw(`GRANT SELECT ON pages, content_chunks, sources, timeline_entries, config TO ${LEGACY}`);
      for (const t of ['pages', 'content_chunks', 'sources', 'timeline_entries', 'config']) {
        await engine.executeRaw(`CREATE POLICY ${LEGACY}_open ON ${t} FOR SELECT TO ${LEGACY} USING (true)`);
        policies.push({ name: `${LEGACY}_open`, table: t });
      }
      const failure = await asRole(engine, LEGACY, tx => tx.searchTitles('ledger', { sourceId: 'src-a' })).then(() => null, (e: { code?: string }) => e.code);
      expect(failure).toBe('42501');
      expect(sourcesOf(await asRole(engine, LEGACY, tx => tx.searchKeyword(SOURCES['src-a'], { sourceId: 'src-a' })))).toEqual(['src-a']);
    }, 120_000);

    test('N7: a non-owner write role under the recipe creates a segmented page, recording its staging holds, and sees only its source', async () => {
      // A login role, so every pooled connection of its engine runs as it, scoped to src-a by its own default.
      const password = randomUUID();
      await engine.executeRaw(`CREATE ROLE ${WRITER} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
      await engine.executeRaw(`ALTER ROLE ${WRITER} SET app.scopes = 'src-a'`);
      await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${WRITER}`);
      await engine.executeRaw(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${WRITER}`);
      await engine.executeRaw(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${WRITER}`);
      // The recipe (and the pages policy) scopes the page tables; every other table under RLS opens to the writer.
      const scoped = new Set(['pages', ...[...docsRecipe(WRITER).matchAll(/CREATE POLICY \w+ ON (\w+)/g)].map(m => m[1]!)]);
      const rls = await engine.executeRaw<{ relname: string }>(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity ORDER BY 1`);
      for (const { relname } of rls.filter(r => !scoped.has(r.relname))) {
        await engine.executeRaw(`CREATE POLICY ${WRITER}_open ON ${relname} FOR ALL TO ${WRITER} USING (true) WITH CHECK (true)`);
        policies.push({ name: `${WRITER}_open`, table: relname });
      }
      const url = new URL(process.env.DATABASE_URL!);
      url.username = WRITER;
      url.password = password;
      const writer = new PostgresEngine();
      await writer.connect({ database_url: url.toString(), poolSize: 4 });
      expect(await writer.executeRaw("SELECT current_user AS role, current_setting('app.scopes', true) AS scopes")).toEqual([{ role: WRITER, scopes: 'src-a' }]);
      try {
        const holds = async () => Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_body_staging_texts t JOIN page_body_stagings s ON s.id = t.staging_id
          WHERE s.source_id = 'src-a' AND s.slug = 'notes/writer-ledger'`))[0]!.n);
        const content = conversationPage(2 * 1024 * 1024, { seed: 73, title: 'Writer ledger', needles: [{ at: 0.4, word: 'writerneedle' }] });
        const imported = await importFromContent(writer, 'notes/writer-ledger', content, { noEmbed: true, sourceId: 'src-a' });
        expect(imported.status).toBe('imported');
        expect(await engine.executeRaw("SELECT body_storage FROM pages WHERE slug = 'notes/writer-ledger' AND source_id = 'src-a'")).toEqual([{ body_storage: 'segmented' }]);
        expect(await holds()).toBeGreaterThan(0);
        expect({
          own: sourcesOf(await writer.searchKeyword('writerneedle')),
          other: sourcesOf(await writer.searchKeyword(SOURCES['src-b'])),
          texts: sourcesOf(await writer.executeRaw<{ source_id: string }>('SELECT DISTINCT source_id FROM page_segment_texts')),
          holds: sourcesOf(await writer.executeRaw<{ source_id: string }>('SELECT DISTINCT source_id FROM page_body_staging_texts')),
          stagings: sourcesOf(await writer.executeRaw<{ source_id: string }>('SELECT DISTINCT source_id FROM page_body_stagings')),
        }).toEqual({ own: ['src-a'], other: [], texts: ['src-a'], holds: ['src-a'], stagings: ['src-a'] });
      } finally {
        await writer.disconnect();
      }
    }, 300_000);
  });
});
