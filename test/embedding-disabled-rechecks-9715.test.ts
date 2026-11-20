/**
 * #9715 follow-up: work that started before the owner turned `embedding_disabled` on checks the setting again before
 * it sends text. A contextual reindex job queued earlier checks when the worker runs it; a multimodal reindex already
 * running checks before each batch; and a source-wide stale sweep that cannot read the setting reports its work as
 * still pending instead of done. A recording transport stands in for the provider. PGLite and, with DATABASE_URL,
 * Postgres. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { makeContextualReindexHandler } from '../src/core/minions/handlers/contextual-reindex-per-chunk.ts';
import { runReindexMultimodal } from '../src/commands/reindex-multimodal.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';
import { reembedPageWithContextualRetrieval } from '../src/core/contextual-retrieval-service.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
const gateway = { embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: '[redacted]' } };
const sent: string[] = [];
beforeAll(() => {
  configureGateway(gateway);
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    sent.push(...values);
    return { embeddings: values.map(() => new Array<number>(DIMS).fill(0.001)), usage: { tokens: 0 } };
  }) as never);
});
afterAll(() => { __setEmbedTransportForTests(null); resetGateway(); });

async function world(databaseUrl: string | undefined, run: (engine: BrainEngine) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-9715-recheck-'));
  try {
    mkdirSync(join(home, '.gbrain'));
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        sent.length = 0;
        await run(engine);
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function stalePage(engine: BrainEngine, slug: string, chunks = 2): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\nA private planning note.` });
  await installFixtureChunks(engine, slug, Array.from({ length: chunks }, (_, i) => ({ chunk_index: i, chunk_text: `chunk ${i} of ${slug}`,
    chunk_source: 'compiled_truth' as const, token_count: 4 })));
}

const job = (slug: string) => ({ id: 1, data: { page_slug: slug, expected_source_id: 'default' }, signal: new AbortController().signal }) as never;

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`#9715 work started before embedding_disabled checks it again before sending (${backend})`, () => {
    test('control: with embedding on, a queued contextual reindex sends the page chunks', async () => {
      await world(databaseUrl, async engine => {
        await stalePage(engine, 'notes/queued');
        await engine.setConfig('search.contextual_retrieval', 'title');
        await makeContextualReindexHandler({ engine })(job('notes/queued'));
        expect(sent.length).toBeGreaterThan(0);
      });
    }, 120_000);

    test('a contextual reindex queued before the setting was turned on sends nothing when the worker runs it', async () => {
      await world(databaseUrl, async engine => {
        await stalePage(engine, 'notes/queued');
        await engine.setConfig('search.contextual_retrieval', 'title');
        await engine.setConfig('embedding_disabled', 'true');
        expect(await makeContextualReindexHandler({ engine })(job('notes/queued'))).toMatchObject({ ok: true, chunks_embedded: 0, skip_reason: 'embedding_disabled' });
        expect(sent).toEqual([]);
      });
    }, 120_000);

    test('a contextual reindex already past its first check sends nothing once the setting is turned on', async () => {
      await world(databaseUrl, async engine => {
        await stalePage(engine, 'notes/inflight');
        await engine.setConfig('search.contextual_retrieval', 'title');
        const original = engine.getPage.bind(engine);
        let reads = 0;
        engine.getPage = (async (...args: Parameters<BrainEngine['getPage']>) => {
          if (++reads === 2) await engine.setConfig('embedding_disabled', 'true');
          return original(...args);
        }) as BrainEngine['getPage'];
        try {
          expect(await makeContextualReindexHandler({ engine })(job('notes/inflight'))).toMatchObject({ ok: true, chunks_embedded: 0, skip_reason: 'embedding_disabled' });
        } finally { engine.getPage = original; }
        expect(reads).toBeGreaterThanOrEqual(2);
        expect(sent).toEqual([]);
      });
    }, 120_000);

    test('a per-chunk synopsis reindex sends no further chunk to the chat model once the setting is turned on', async () => {
      await world(databaseUrl, async engine => {
        await stalePage(engine, 'notes/synopsis', 3);
        const synopses: number[] = [];
        const result = await reembedPageWithContextualRetrieval({ engine, pageSlug: 'notes/synopsis', sourceId: 'default', globalMode: 'per_chunk_synopsis',
          chunkConcurrency: 1, generateSynopsis: (async (input: { chunkIndex: number }) => {
            synopses.push(input.chunkIndex);
            await engine.setConfig('embedding_disabled', 'true');
            return { kind: 'success', synopsis: 'a synopsis' };
          }) as never });
        expect(result).toMatchObject({ kind: 'skipped', reason: 'embedding_disabled' });
        expect(synopses).toEqual([0]);
        expect(sent).toEqual([]);
      });
    }, 120_000);

    test('a contextual reindex that cannot read the setting sends nothing and retries', async () => {
      await world(databaseUrl, async engine => {
        await stalePage(engine, 'notes/queued');
        await engine.setConfig('search.contextual_retrieval', 'title');
        const original = engine.getConfig.bind(engine);
        engine.getConfig = async (key: string) => {
          if (key === 'embedding_disabled') throw new Error('synthetic config read failure');
          return original(key);
        };
        try {
          await expect(makeContextualReindexHandler({ engine })(job('notes/queued'))).rejects.toThrow(/transient error/);
        } finally { engine.getConfig = original; }
        expect(sent).toEqual([]);
      });
    }, 120_000);

    test('a running multimodal reindex sends no batch after the setting is turned on', async () => {
      await world(databaseUrl, async engine => {
        await stalePage(engine, 'notes/many', 40);
        const calls: number[] = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
          const inputs = (JSON.parse(String(init?.body ?? '{}')).inputs ?? []) as unknown[];
          calls.push(inputs.length);
          if (calls.length === 1) await engine.setConfig('embedding_disabled', 'true');
          return new Response(JSON.stringify({ data: inputs.map((_, index) => ({ embedding: new Array(1024).fill(0.1), index })), model: 'voyage-multimodal-3' }), { status: 200 });
        }) as typeof fetch;
        configureGateway({ ...gateway, embedding_multimodal_model: 'voyage:voyage-multimodal-3', env: { ...gateway.env, VOYAGE_API_KEY: '[redacted]' } } as never);
        try {
          await expect(runReindexMultimodal(engine, { yes: true })).rejects.toMatchObject({ name: 'EmbeddingDisabledError' });
        } finally { globalThis.fetch = originalFetch; configureGateway(gateway); }
        expect(calls).toEqual([32]);
      });
    }, 120_000);

    test('a source-wide stale sweep that cannot read the setting sends nothing and leaves the work pending', async () => {
      await world(databaseUrl, async engine => {
        await stalePage(engine, 'notes/backlog');
        const original = engine.getConfig.bind(engine);
        engine.getConfig = async (key: string) => {
          if (key === 'embedding_disabled') throw new Error('synthetic config read failure');
          return original(key);
        };
        try {
          expect(await embedStaleForSource(engine, 'default')).toMatchObject({ embedded: 0, complete: false });
        } finally { engine.getConfig = original; }
        expect(sent).toEqual([]);
      });
    }, 120_000);
  });
}
