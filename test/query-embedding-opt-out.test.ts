/**
 * A brain that opted out of embedding never sends query text to the
 * embedding provider: search, query, recall and think run keyword-only and
 * record it (retrieval degraded `embed_unavailable` / `embedding_disabled`,
 * recall `keyword_only_embedding_disabled`, think
 * `QUESTION_EMBED_SKIPPED_EMBEDDING_DISABLED`). Keyword-only on purpose is not
 * degraded: MCP search, query and recall carry no degraded stamp and no
 * `degraded_recall` notice, while a brain with no provider configured still
 * gets both. Image search refuses with
 * `embedding_disabled`. A brain with embedding on still embeds the query.
 * A fake embedder records every call. PostgreSQL arm:
 * test/e2e/query-embedding-opt-out.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { embedQuery } from '../src/core/embedding.ts';
import { runThink } from '../src/core/think/index.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetProcessNoticeLedgerForTests } from '../src/core/notice-ledger.ts';
import { prepareMarkdownChunks } from '../src/core/markdown-chunks.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

// Wire values (src/core/interop-notices.ts), spelled out so this file also runs against code without them.
const QUESTION_EMBED_OPTED_OUT = 'QUESTION_EMBED_SKIPPED_EMBEDDING_DISABLED';
const RECALL_KEYWORD_ONLY_OPTED_OUT = 'keyword_only_embedding_disabled';
const PAGES = [
  { slug: 'notes/heron-handbook', body: 'The heron program runs quarterly reviews. Heron pricing is tiered by seat.' },
  { slug: 'notes/heron-roadmap', body: 'Heron roadmap: the next heron milestone ships in spring.' },
];
let embedded: string[] = [];

beforeEach(() => {
  embedded = [];
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: { OPENAI_API_KEY: 'fixture-key' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    embedded.push(...values);
    return { embeddings: values.map(() => [1, ...Array(LEGACY_EMBEDDING_CONFIG.embedding_dimensions - 1).fill(0)]) };
  }) as never);
});
afterEach(() => { __setEmbedTransportForTests(null); });
afterAll(() => { resetGateway(); }); // R5: restore the preload baseline for later files in this shard

function ctxOf(engine: BrainEngine, meta: Array<{ key: string; value: unknown }>): OperationContext {
  return { engine: engine as never, config: { engine: engine.kind } as never, logger: console as never, dryRun: false, remote: false, sourceId: 'default',
    emitResponseMeta: (key: string, value: unknown) => { meta.push({ key, value }); } } as OperationContext;
}
const retrievalOf = (meta: Array<{ key: string; value: unknown }>) =>
  meta.find(m => m.key === 'retrieval')?.value as { vector_enabled: boolean; degraded?: Array<{ stage: string; reason?: string }> };

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`read paths on a brain that opted out of embedding send no query text to the provider (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (databaseUrl) {
        ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
      } else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
      for (const p of PAGES) {
        await engine.putPage(p.slug, { type: 'note', title: p.slug, compiled_truth: p.body, timeline: '', frontmatter: {} });
        await installFixtureChunks(engine, p.slug, await prepareMarkdownChunks({ compiled_truth: p.body, timeline: '' }));
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('search and query run keyword-only with the embedding_disabled degraded reason', async () => {
      await engine.setConfig('embedding_disabled', 'true');
      for (const [op, params] of [['search', { query: 'heron pricing' }], ['query', { query: 'heron pricing', expand: false }]] as const) {
        const meta: Array<{ key: string; value: unknown }> = [];
        const rows = await operationsByName[op]!.handler(ctxOf(engine, meta), params) as Array<{ slug: string }>;
        expect(rows.map(r => r.slug)).toContain('notes/heron-handbook');
        const retrieval = retrievalOf(meta);
        expect(retrieval.vector_enabled).toBe(false);
        expect(retrieval.degraded).toContainEqual({ stage: 'embed_unavailable', reason: 'embedding_disabled' });
      }
      expect(embedded).toEqual([]);
    }, 120_000);

    test('recall and think skip the embedder and say so', async () => {
      await engine.setConfig('embedding_disabled', 'true');
      const recalled = await operationsByName.recall!.handler(ctxOf(engine, []), { query: 'heron roadmap' }) as { search_degraded?: string };
      expect(recalled.search_degraded).toBe(RECALL_KEYWORD_ONLY_OPTED_OUT);
      const thought = await runThink(engine, {
        question: 'What is on the heron roadmap?', remote: false, embedQuestion: q => embedQuery(q),
        client: { create: async () => ({ content: [{ type: 'text', text: '{"answer":"ok","citations":[],"gaps":[]}' }], usage: { input_tokens: 1, output_tokens: 1 } }) } as never,
      });
      expect(thought.warnings).toContain(QUESTION_EMBED_OPTED_OUT);
      expect(embedded).toEqual([]);
    }, 120_000);

    test('MCP search, query and recall carry no degraded stamp and no degraded_recall notice, and still record the keyword-only run', async () => {
      await engine.setConfig('embedding_disabled', 'true');
      __resetProcessNoticeLedgerForTests();
      await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, async () => {
        for (const [op, params] of [['search', { query: 'heron pricing' }], ['query', { query: 'heron pricing' }], ['recall', { query: 'heron pricing' }],
          ['search', { query: 'zebra flamingo' }]] as const) {
          const res = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'stdio', sourceId: 'default' }) as
            { content: Array<{ text: string }>; _meta?: Record<string, unknown>; isError?: boolean };
          expect(res.isError).toBeFalsy();
          expect(res._meta?.degraded).toBeUndefined();
          expect(res.content.map(c => c.text).join('\n')).not.toContain('[gbrain degraded:');
          const notices = (res._meta?.gbrain_notices ?? []) as Array<{ code: string; kind: string; why?: string }>;
          expect(notices.filter(n => n.code === 'degraded_recall' || n.kind === 'degraded')).toEqual([]);
          if (op === 'recall') {
            expect(JSON.parse(res.content[0]!.text).search_degraded).toBe(RECALL_KEYWORD_ONLY_OPTED_OUT);
          } else if (params.query === 'zebra flamingo') {
            const empty = notices.find(n => n.code === 'empty_retrieval')!;
            expect(empty.kind).toBe('info');
            expect(empty.why).toContain('Search was keyword-only because embeddings are off on this brain on purpose, and no page this caller can read holds these words');
          } else {
            const retrieval = res._meta?.retrieval as { vector_enabled: boolean; degraded: Array<{ stage: string; reason?: string }> };
            expect(retrieval.vector_enabled).toBe(false);
            expect(retrieval.degraded).toContainEqual({ stage: 'embed_unavailable', reason: 'embedding_disabled' });
          }
        }
      });
      expect(embedded).toEqual([]);
    }, 120_000);

    test('with no embedding provider configured (not turned off on purpose) every search is still stamped and noticed', async () => {
      await engine.setConfig('embedding_disabled', 'false');
      __resetProcessNoticeLedgerForTests();
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      await withEnv({ GBRAIN_BACKUP_CHECK: '0', OPENAI_API_KEY: undefined }, async () => {
        const res = await dispatchToolCall(engine, 'search', { query: 'heron pricing' }, { remote: true, transport: 'stdio', sourceId: 'default' }) as
          { content: Array<{ text: string }>; _meta?: Record<string, unknown> };
        expect((res._meta?.degraded as { reasons: string[] }).reasons).toContain('embed_unavailable');
        expect(res.content[res.content.length - 1]!.text).toContain('[gbrain degraded: embed_unavailable');
        expect(((res._meta?.gbrain_notices ?? []) as Array<{ code: string }>).map(n => n.code)).toContain('degraded_recall');
        const recall = await dispatchToolCall(engine, 'recall', { query: 'heron pricing' }, { remote: true, transport: 'stdio', sourceId: 'default' }) as
          { _meta?: Record<string, unknown> };
        expect((recall._meta?.degraded as { reasons: string[] }).reasons).toContain('embed_unavailable');
      });
    }, 120_000);

    test('image search refuses with embedding_disabled before anything is sent', async () => {
      await engine.setConfig('embedding_disabled', 'true');
      await expect(operationsByName.query!.handler(ctxOf(engine, []), { image: 'aGVsbG8=', image_mime: 'image/png' }))
        .rejects.toMatchObject({ name: 'EmbeddingDisabledError' });
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      await expect(operationsByName.search_by_image!.handler(ctxOf(engine, []), { image_data: png, query: 'heron' }))
        .rejects.toMatchObject({ name: 'EmbeddingDisabledError' });
      expect(embedded).toEqual([]);
    }, 120_000);

    test('a brain with embedding on still embeds the query', async () => {
      await engine.setConfig('embedding_disabled', 'false');
      const meta: Array<{ key: string; value: unknown }> = [];
      await operationsByName.search!.handler(ctxOf(engine, meta), { query: 'heron pricing' });
      expect(embedded).toContain('heron pricing');
      expect(retrievalOf(meta).vector_enabled).toBe(true);
      expect(retrievalOf(meta).degraded ?? []).not.toContainEqual({ stage: 'embed_unavailable', reason: 'embedding_disabled' });
    }, 120_000);
  });
}
