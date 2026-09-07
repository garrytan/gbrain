/** Real imports and materialized legacy chunks, not pre-cleaned chunk fixtures.
 * PostgreSQL uses only these synthetic sources and this unique reindex type.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { readPolicyOpts } from '../../src/core/ops/context.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { runReindex } from '../../src/commands/reindex.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../../src/core/chunkers/recursive.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, renderFactsTable } from '../../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { __resetPrivateVisibilityCacheForTests } from '../../src/core/search/private-visibility.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const [A, B, FOREIGN] = ['chunk-privacy-a', 'chunk-privacy-b', 'chunk-privacy-foreign'];
const SOURCES = [A, B, FOREIGN];
const TYPE = 'legacy-chunk-privacy-fixture';
const PRIVATE = 'PRIVATE_PERSISTED_CHUNK_CANARY';
const QUERY = 'orbitchunkmarker';
const takes = (body: string) => `${TAKES_FENCE_BEGIN}\n${body}\n${TAKES_FENCE_END}`;
const facts = (world: string) => renderFactsTable([
  { rowNum: 1, claim: world, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
  { rowNum: 2, claim: PRIVATE, kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
]);
const variants = [
  { name: 'repeated-takes', body: `${takes(PRIVATE)}\n${takes(`${PRIVATE}_SECOND`)}`, world: undefined },
  { name: 'repeated-facts', body: `${facts('WORLD_FIRST_CHUNK_FACT')}\n${facts('WORLD_SECOND_CHUNK_FACT')}`, world: 'WORLD_SECOND_CHUNK_FACT' },
  { name: 'unterminated-takes', body: `${TAKES_FENCE_BEGIN}\n${PRIVATE}`, world: undefined },
  { name: 'unterminated-facts', body: `${FACTS_FENCE_BEGIN}\n${PRIVATE}`, world: undefined },
  { name: 'malformed-facts', body: `${FACTS_FENCE_BEGIN}\n${PRIVATE} is not a parseable Facts table.\n${FACTS_FENCE_END}`, world: undefined },
  { name: 'protected-code', body: takes(`\`\`\`typescript\nexport const forbidden = '${PRIVATE}';\n\`\`\``), world: undefined },
] as const;

for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`${kind}: imported and legacy chunk privacy`, () => {
    let engine: BrainEngine;

    beforeAll(async () => {
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      engine = kind === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
      if (kind === 'postgres') assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
      await engine.connect(kind === 'postgres' ? { database_url: process.env.DATABASE_URL! } : {});
      await engine.initSchema();
      for (const source of SOURCES) {
        await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
      }
    }, 120_000);

    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM pages WHERE source_id = ANY($1::text[])', [SOURCES]);
      await engine.setConfig('search.mcp_keyword_only', 'true');
      await engine.setConfig('search.crag_escalation', 'false');
      await engine.unsetConfig('search.remote_private_pages');
      __resetPrivateVisibilityCacheForTests();
    });

    afterAll(async () => {
      if (engine) {
        try {
          await engine.executeRaw('DELETE FROM sources WHERE id = ANY($1::text[])', [SOURCES]);
          for (const key of ['search.mcp_keyword_only', 'search.crag_escalation', 'search.remote_private_pages']) await engine.unsetConfig(key);
        } finally { await engine.disconnect(); }
      }
      __resetPrivateVisibilityCacheForTests();
      resetGateway();
    }, 60_000);

    function context(remote: boolean | undefined, sourceId = A, allowedSources?: string[]): OperationContext {
      return {
        engine, config: { engine: 'pglite' }, dryRun: false, remote: remote as boolean, sourceId,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        ...(allowedSources !== undefined ? { auth: {
          token: 'fixture', clientId: 'chunk-reader-example', scopes: ['read'], allowedSources,
        } } : {}),
      };
    }

    const call = (ctx: OperationContext, name: string, args: Record<string, unknown>) => operationsByName[name].handler(ctx, args);

    async function legacy(slug: string, sourceId: string, body: string, text: string, timeline = ''): Promise<number> {
      const page = await engine.putPage(slug, {
        type: TYPE, title: 'Synthetic old document', compiled_truth: body, timeline,
        frontmatter: { visibility: 'world' }, chunker_version: 3,
      }, { sourceId });
      // An old overlapping chunk can contain only the private fragment: output
      // fence stripping alone cannot recognize or repair this payload.
      await engine.executeRaw("INSERT INTO content_chunks (page_id, chunk_index, chunk_source, chunk_text) VALUES ($1, 0, 'compiled_truth', $2)", [page.id, text]);
      return page.id;
    }

    async function safe(slug: string, sourceId: string, body: string): Promise<number> {
      const result = await importFromContent(engine, slug,
        serializeMarkdown({ visibility: 'world' }, body, '', { type: TYPE, title: 'Synthetic safely imported document', tags: [] }),
        { sourceId, noEmbed: true, forceRechunk: true });
      expect(result.status).toBe('imported');
      return (await engine.getPage(slug, { sourceId }))!.id;
    }

    test('actual imports strip every protected section from prose, timeline, and fenced-code chunks', async () => {
      expect(MARKDOWN_CHUNKER_VERSION).toBeGreaterThanOrEqual(4);
      for (const variant of variants) {
        const slug = `notes/import-${variant.name}`;
        const publicToken = `publicchunk${variant.name.replaceAll('-', '')}`;
        const content = serializeMarkdown({ visibility: 'world' },
          `Ordinary public context ${publicToken}.\n\n${variant.body}\n\n\`\`\`typescript\nexport const publicExample = '${publicToken}';\n\`\`\``,
          `Public timeline ${publicToken}.\n${variant.body}`,
          { type: TYPE, title: `Imported ${variant.name}`, tags: [] });
        const imported = await importFromContent(engine, slug, content, { sourceId: A, noEmbed: true, forceRechunk: true });
        expect(imported.status, `${variant.name}: ${imported.error ?? ''}`).toBe('imported');
        expect((await engine.getPage(slug, { sourceId: A }))?.compiled_truth).toContain(PRIVATE);
        const [version] = await engine.executeRaw<{ chunker_version: number }>('SELECT chunker_version FROM pages WHERE source_id = $1 AND slug = $2', [A, slug]);
        expect(Number(version.chunker_version)).toBe(MARKDOWN_CHUNKER_VERSION);
        const stored = await engine.getChunks(slug, { sourceId: A });
        expect(stored.length).toBeGreaterThan(0);
        expect(JSON.stringify(stored)).toContain(publicToken);
        expect(JSON.stringify(stored)).not.toContain(PRIVATE);
        if (variant.world) expect(JSON.stringify(stored)).toContain(variant.world);
        for (const remote of [true, undefined]) {
          const ctx = context(remote);
          const chunks = await call(ctx, 'get_chunks', { slug });
          expect(JSON.stringify(chunks)).toContain(publicToken);
          expect(JSON.stringify(chunks)).not.toContain(PRIVATE);
          const results = await call(ctx, 'search', { query: publicToken, limit: 5 });
          expect(JSON.stringify(results)).toContain(publicToken);
          expect(JSON.stringify(results)).not.toContain(PRIVATE);
        }
      }
    }, 60_000);

    test('unsafe legacy fragments are excluded before keyword/vector limits for remote and unset-trust scopes', async () => {
      const slug = 'notes/legacy-shared';
      const unsafe = await legacy(slug, A, `Public current body.\n${takes(PRIVATE)}`, `${QUERY} ${PRIVATE}`);
      // Current bodies cannot prove what an older materialized chunk contains.
      // Both unsafe and entirely public old chunks require a rebuild remotely.
      const markerFree = await legacy('notes/legacy-marker-free', A, 'Current body has no fence markers.', `${QUERY} ${PRIVATE}_NO_MARKERS`);
      await legacy('notes/legacy-public', A, `${QUERY} OLD_PUBLIC_CHUNK`, `${QUERY} OLD_PUBLIC_CHUNK`);
      const cleanA = await safe('notes/current-clean', A, `${QUERY} PUBLIC_CLEAN_A`);
      const cleanB = await safe(slug, B, `${QUERY} PUBLIC_CLEAN_B`);
      await safe('notes/current-foreign', FOREIGN, `${QUERY} PUBLIC_FOREIGN`);
      const [column] = await engine.executeRaw<{ dims: number }>("SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'");
      const vector = new Float32Array(Number(column.dims));
      vector[0] = 1;
      const cleanVector = vector.slice();
      cleanVector[0] = 0.8; cleanVector[1] = 0.6;
      const markerFreeVector = vector.slice();
      markerFreeVector[0] = 0.96; markerFreeVector[1] = 0.28;
      await engine.executeRaw('UPDATE content_chunks SET embedding = $1::vector WHERE page_id = ANY($2::int[])', [`[${Array.from(cleanVector)}]`, [cleanA, cleanB]]);
      await engine.executeRaw('UPDATE content_chunks SET embedding = $1::vector WHERE page_id = $2', [`[${Array.from(vector)}]`, unsafe]);
      await engine.executeRaw('UPDATE content_chunks SET embedding = $1::vector WHERE page_id = $2', [`[${Array.from(markerFreeVector)}]`, markerFree]);
      expect(JSON.stringify(await call(context(false), 'get_chunks', { slug }))).toContain(PRIVATE);
      expect(JSON.stringify(await call(context(false), 'get_chunks', { slug: 'notes/legacy-marker-free' }))).toContain(`${PRIVATE}_NO_MARKERS`);
      expect(JSON.stringify(await call(context(false), 'get_chunks', { slug: 'notes/legacy-public' }))).toContain('OLD_PUBLIC_CHUNK');

      for (const exposePrivatePages of [false, true]) {
        if (exposePrivatePages) await engine.setConfig('search.remote_private_pages', 'visible');
        else await engine.unsetConfig('search.remote_private_pages');
        __resetPrivateVisibilityCacheForTests();
        for (const remote of [true, undefined]) {
          for (const scope of [
            { ctx: context(remote), allowedIds: [cleanA], sharedChunk: undefined },
            { ctx: context(remote, A, []), allowedIds: [cleanA], sharedChunk: undefined },
            { ctx: context(remote, FOREIGN, [A, B]), allowedIds: [cleanA, cleanB], sharedChunk: 'PUBLIC_CLEAN_B' },
          ]) {
            const chunks = await call(scope.ctx, 'get_chunks', { slug });
            if (scope.sharedChunk) expect(JSON.stringify(chunks)).toContain(scope.sharedChunk);
            else expect(chunks).toEqual([]);
            expect(JSON.stringify(chunks)).not.toContain(PRIVATE);
            expect(await call(scope.ctx, 'get_chunks', { slug: 'notes/legacy-marker-free' })).toEqual([]);
            expect(await call(scope.ctx, 'get_chunks', { slug: 'notes/legacy-public' })).toEqual([]);
            const policy = await readPolicyOpts(scope.ctx);
            for (const rows of [
              await engine.searchKeyword(QUERY, { ...policy, limit: 1 }),
              await engine.searchKeywordChunks(QUERY, { ...policy, limit: 1 }),
              await engine.searchVector(vector, { ...policy, limit: 1 }),
            ]) {
              expect(rows).toHaveLength(1);
              expect(scope.allowedIds).toContain(rows[0].page_id);
              expect(JSON.stringify(rows)).not.toContain(PRIVATE);
            }
            for (const keywordOnly of ['true', 'false']) {
              await engine.setConfig('search.mcp_keyword_only', keywordOnly);
              for (const name of ['search', 'query']) {
                const rows = await call(scope.ctx, name, { query: QUERY, expand: false, limit: 1 }) as SearchResult[];
                expect(rows).toHaveLength(1);
                expect(scope.allowedIds).toContain(rows[0].page_id);
                expect(JSON.stringify(rows)).not.toContain(PRIVATE);
              }
            }
          }
        }
      }
      const policy = await readPolicyOpts(context(true));
      const before = await engine.searchVector(vector, { ...policy, limit: 1 });
      await engine.executeRaw('UPDATE content_chunks SET chunk_text = $1 WHERE page_id = $2', [`${QUERY} `.repeat(100) + PRIVATE, unsafe]);
      const after = await engine.searchVector(vector, { ...policy, limit: 1 });
      expect(after.map(row => [row.page_id, row.score])).toEqual(before.map(row => [row.page_id, row.score]));
      expect((await engine.searchVector(vector, { sourceId: A, limit: 1 }))[0].page_id).toBe(unsafe);
    }, 60_000);

    test('direct page rewrites cannot bless unsafe chunks even after protected markers are removed', async () => {
      const slug = 'notes/rewrite-cannot-bless';
      const id = await legacy(slug, A, `Original public context.\n${takes(PRIVATE)}`, `${QUERY} ${PRIVATE}`);
      for (const body of [`Edited public context.\n${takes(PRIVATE)}`, 'Edited public context without any fence markers.']) {
        await engine.putPage(slug, {
          type: TYPE, title: 'Synthetic rewritten document', compiled_truth: body, timeline: '',
          frontmatter: { visibility: 'world' }, chunker_version: MARKDOWN_CHUNKER_VERSION,
        }, { sourceId: A });
        expect((await engine.getPage(slug, { sourceId: A }))?.compiled_truth).toBe(body);
        expect(JSON.stringify(await engine.getChunks(slug, { sourceId: A }))).toContain(PRIVATE);
        for (const remote of [true, undefined]) {
          expect(await call(context(remote), 'get_chunks', { slug })).toEqual([]);
          expect(await call(context(remote), 'search', { query: QUERY, limit: 1 })).toEqual([]);
        }
      }
      const [invalidated] = await engine.executeRaw<{ chunker_version: number }>('SELECT chunker_version FROM pages WHERE id = $1', [id]);
      expect(Number(invalidated.chunker_version)).toBeLessThan(0);
      const repaired = await importFromContent(engine, slug,
        serializeMarkdown({ visibility: 'world' }, `${QUERY} public replacement after successful import.`, '', { type: TYPE, title: 'Repaired synthetic document', tags: [] }),
        { sourceId: A, noEmbed: true, forceRechunk: true });
      expect(repaired.status).toBe('imported');
      const chunks = await call(context(true), 'get_chunks', { slug });
      expect(JSON.stringify(chunks)).toContain('public replacement');
      expect(JSON.stringify(chunks)).not.toContain(PRIVATE);
      expect((await call(context(true), 'search', { query: QUERY, limit: 1 }) as SearchResult[])[0].page_id).toBe(id);
    }, 60_000);

    test('failed import rolls back partial chunk replacement and cannot mark legacy material safe', async () => {
      const slug = 'notes/partial-chunk-failure';
      const id = await legacy(slug, A, `Original public context.\n${takes(PRIVATE)}`, `${QUERY} ${PRIVATE}`);
      const originalChunks = await engine.getChunks(slug, { sourceId: A });
      const [originalVersion] = await engine.executeRaw<{ chunker_version: number }>('SELECT chunker_version FROM pages WHERE id = $1', [id]);
      let wrotePartialChunks = false;
      // Inject one failure at the storage boundary after a real chunk write.
      // The real engine transaction must roll back both page/version and chunks.
      const failingEngine = new Proxy(engine, {
        get(target, key) {
          if (key === 'transaction') return <T>(fn: (tx: BrainEngine) => Promise<T>) => target.transaction(tx => fn(new Proxy(tx, {
            get(transaction, method) {
              if (method === 'upsertChunks') return async (...args: Parameters<BrainEngine['upsertChunks']>) => {
                await transaction.upsertChunks(args[0], args[1].slice(0, 1), args[2]);
                wrotePartialChunks = true;
                throw new Error('synthetic chunk storage failure');
              };
              const value = Reflect.get(transaction, method);
              return typeof value === 'function' ? value.bind(transaction) : value;
            },
          })));
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const content = serializeMarkdown({ visibility: 'world' }, `${QUERY} new safe replacement.\n${takes(PRIVATE)}\n${facts('WORLD_REPAIRED_FACT')}`,
        'Public replacement timeline.', { type: TYPE, title: 'Repaired synthetic document', tags: [] });
      await expect(importFromContent(failingEngine, slug, content, { sourceId: A, noEmbed: true, forceRechunk: true })).rejects.toThrow('synthetic chunk storage failure');
      expect(wrotePartialChunks).toBe(true);
      expect(await engine.getChunks(slug, { sourceId: A })).toEqual(originalChunks);
      expect((await engine.executeRaw('SELECT chunker_version FROM pages WHERE id = $1', [id]))[0]).toEqual(originalVersion);
      for (const remote of [true, undefined]) {
        expect(await call(context(remote), 'get_chunks', { slug })).toEqual([]);
        expect(await call(context(remote), 'search', { query: QUERY, limit: 1 })).toEqual([]);
      }
      expect((await importFromContent(engine, slug, content, { sourceId: A, noEmbed: true, forceRechunk: true })).status).toBe('imported');
      const chunks = await call(context(true), 'get_chunks', { slug });
      expect(JSON.stringify(chunks)).toContain('new safe replacement');
      expect(JSON.stringify(chunks)).toContain('WORLD_REPAIRED_FACT');
      expect(JSON.stringify(chunks)).not.toContain(PRIVATE);
    }, 60_000);

    test('keyless rebuild discards every old vector and derived field even when public chunk text is unchanged', async () => {
      const slug = 'notes/same-text-derived-state';
      const id = await safe(slug, A, `${QUERY} public text stays unchanged.\n${takes(PRIVATE)}`);
      const [canonical] = await engine.getChunks(slug, { sourceId: A });
      expect(canonical.chunk_text).not.toContain(PRIVATE);
      // Model a pre-fix contextual embedding built from the whole document,
      // including a private sibling: unchanged public text is not provenance.
      await engine.executeRaw('UPDATE pages SET chunker_version = 3 WHERE id = $1', [id]);
      await engine.executeRaw("INSERT INTO content_chunks (page_id, chunk_index, chunk_source, chunk_text) VALUES ($1, 999, 'compiled_truth', $2)", [id, PRIVATE]);
      await engine.executeRaw(`UPDATE content_chunks SET doc_comment = $2, symbol_name = $2,
        symbol_name_qualified = $2, parent_symbol_path = ARRAY[$2::text], model = $2,
        language = $2, symbol_type = $2, modality = 'image', token_count = 999999,
        embedded_text_hash = $2, embedded_at = now(), start_line = 123, end_line = 124
        WHERE page_id = $1`, [id, PRIVATE]);
      const columns = await engine.executeRaw<{ name: string; dims: number; type: string }>(`
        SELECT a.attname AS name, a.atttypmod AS dims, t.typname AS type
        FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
        WHERE a.attrelid = 'content_chunks'::regclass AND NOT a.attisdropped
          AND t.typname IN ('vector', 'halfvec')`);
      expect(columns.length).toBeGreaterThan(0);
      for (const column of columns) {
        expect(column.name).toMatch(/^[a-z_][a-z0-9_]*$/);
        const vector = new Array(Number(column.dims) > 0 ? Number(column.dims) : 1536).fill(0);
        vector[0] = 1;
        await engine.executeRaw(`UPDATE content_chunks SET "${column.name}" = $1::${column.type} WHERE page_id = $2`, [`[${vector}]`, id]);
      }
      expect(JSON.stringify(await engine.getChunks(slug, { sourceId: A }))).toContain(PRIVATE);
      expect(await call(context(true), 'get_chunks', { slug })).toEqual([]);

      expect(await runReindex(engine, ['--markdown', '--no-embed', '--type', TYPE])).toMatchObject({ reindexed: 1, failed: 0, pendingAfter: 0 });
      const chunks = await call(context(true), 'get_chunks', { slug }) as Array<{ chunk_text: string }>;
      expect(chunks.some(chunk => chunk.chunk_text === canonical.chunk_text)).toBe(true);
      expect(JSON.stringify(chunks)).not.toContain(PRIVATE);
      const derived = await engine.executeRaw<Record<string, unknown>>(`SELECT ${columns.map(column => `"${column.name}" IS NULL AS "${column.name}"`).join(', ')},
        doc_comment, symbol_name, symbol_name_qualified, parent_symbol_path, embedded_text_hash, embedded_at,
        language, symbol_type, start_line, end_line, modality, token_count
        FROM content_chunks WHERE page_id = $1`, [id]);
      expect(derived.length).toBeGreaterThan(0);
      for (const row of derived) {
        for (const column of columns) expect(row[column.name], column.name).toBe(true);
        for (const field of ['doc_comment', 'symbol_name', 'symbol_name_qualified', 'parent_symbol_path', 'embedded_text_hash', 'embedded_at', 'language', 'symbol_type', 'start_line', 'end_line']) expect(row[field], field).toBeNull();
        expect(row.modality).toBe('text');
        expect(row.token_count).not.toBe(999999);
      }
      const rows = await call(context(true), 'search', { query: QUERY, limit: 1 }) as SearchResult[];
      expect(rows[0].page_id).toBe(id);
      expect(JSON.stringify(rows)).not.toContain(PRIVATE);
    }, 60_000);

    test('markdown reindex upgrades legacy protected bodies and restores only safe public chunks', async () => {
      const slugs: string[] = [];
      for (const variant of variants) {
        const slug = `notes/reindex-${variant.name}`;
        slugs.push(slug);
        await legacy(slug, A, `reindexpublic ${variant.name}.\n${variant.body}`, PRIVATE,
          `reindexpublic timeline ${variant.name}.\n${variant.body}`);
        expect(await call(context(true), 'get_chunks', { slug })).toEqual([]);
      }
      // Also cover a protected section that exists only in the timeline column.
      const timelineSlug = 'notes/reindex-timeline-only';
      slugs.push(timelineSlug);
      await legacy(timelineSlug, A, 'reindexpublic body without fences.', PRIVATE,
        `reindexpublic timeline.\n${takes(PRIVATE)}\n${takes(`${PRIVATE}_SECOND`)}`);
      expect(await call(context(true), 'get_chunks', { slug: timelineSlug })).toEqual([]);
      const markerFreeSlug = 'notes/reindex-marker-free';
      slugs.push(markerFreeSlug);
      await legacy(markerFreeSlug, A, 'reindexpublic current body without any private content or markers.', PRIVATE);
      expect(await call(context(true), 'get_chunks', { slug: markerFreeSlug })).toEqual([]);

      const reindexed = await runReindex(engine, ['--markdown', '--no-embed', '--type', TYPE]);
      expect(reindexed).toMatchObject({ reindexed: slugs.length, failed: 0, pendingAfter: 0, chunkerVersion: MARKDOWN_CHUNKER_VERSION });
      const versions = await engine.executeRaw<{ chunker_version: number }>('SELECT chunker_version FROM pages WHERE source_id = $1', [A]);
      expect(versions).toHaveLength(slugs.length);
      expect(versions.every(row => Number(row.chunker_version) >= 4)).toBe(true);
      for (const slug of slugs) {
        const chunks = await call(context(true), 'get_chunks', { slug });
        expect(JSON.stringify(chunks)).toContain('reindexpublic');
        expect(JSON.stringify(chunks)).not.toContain(PRIVATE);
        if (slug !== markerFreeSlug) expect(JSON.stringify(await engine.getPage(slug, { sourceId: A }))).toContain(PRIVATE);
      }
      const rows = await call(context(true), 'search', { query: 'reindexpublic', limit: 20 }) as SearchResult[];
      expect(new Set(rows.map(row => row.slug))).toEqual(new Set(slugs));
      expect(JSON.stringify(rows)).not.toContain(PRIVATE);
      expect(await runReindex(engine, ['--markdown', '--no-embed', '--type', TYPE])).toMatchObject({ reindexed: 0, pending: 0, failed: 0 });
    }, 60_000);
  });
}
