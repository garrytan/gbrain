/**
 * Fresh-init receipt per search mode: the settings a new brain resolves and
 * the provider calls one `put_page`, one `search` and one `query` make in
 * each mode, with every provider stubbed (embedding, rerank, expansion). It
 * pins what choosing a mode at init actually changes on the agent read and
 * write paths: `query` does not expand by default in any mode (GBRA-94),
 * `search` never does, conservative never reranks, and `put_page` makes no provider call in
 * any mode (it queues the page's embedding; per-chunk synopses come only from
 * the separate contextual-retrieval backfill).
 *
 * Serial: configures the process-global gateway and its test transports.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { runModePicker } from '../../src/commands/init-mode-picker.ts';
import { loadSearchModeConfig, resolveSearchMode, type SearchMode } from '../../src/core/search/mode.ts';
import {
  configureGateway, resetGateway,
  __setEmbedTransportForTests, __setGenerateObjectTransportForTests, __setGenerateTextTransportForTests,
  __setRerankTransportForTests, __setChatTransportForTests, __clearQueryEmbedCacheForTests,
} from '../../src/core/ai/gateway.ts';

const DIMS = 1536;
const calls = { embed: 0, rerank: 0, expand: 0, chat: 0 };
const reset = () => { calls.embed = 0; calls.rerank = 0; calls.expand = 0; calls.chat = 0; };

beforeAll(() => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS,
    expansion_model: 'anthropic:claude-haiku-5-5',
    env: { OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant-test', VOYAGE_API_KEY: 'pa-test' },
  });
  __setEmbedTransportForTests((async (p: { values: string[] }) => {
    calls.embed++;
    return { embeddings: p.values.map(() => Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0.01))), values: p.values, warnings: [], usage: { tokens: p.values.length } };
  }) as never);
  __setGenerateObjectTransportForTests((async () => {
    calls.expand++;
    return { object: { queries: ['zirconium needle fixture notes', 'notes about the needle fixture'] }, usage: { inputTokens: 100, outputTokens: 20 } };
  }) as never);
  __setGenerateTextTransportForTests((async () => { calls.chat++; return { text: '{"queries":[]}', usage: {} }; }) as never);
  __setChatTransportForTests(async () => { calls.chat++; throw new Error('no chat in this receipt'); });
  __setRerankTransportForTests(async (_url, init) => {
    calls.rerank++;
    const docs = (JSON.parse(String(init.body)) as { documents: string[] }).documents;
    return new Response(JSON.stringify({ results: docs.map((_, index) => ({ index, relevance_score: 1 - index / 100 })) }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterAll(() => {
  __setEmbedTransportForTests(null);
  __setGenerateObjectTransportForTests(null);
  __setGenerateTextTransportForTests(null);
  __setChatTransportForTests(null);
  __setRerankTransportForTests(null);
  resetGateway();
});

function ctx(engine: PGLiteEngine): OperationContext {
  return { engine, remote: false, sourceId: 'default', config: { engine: 'pglite' }, logger: console, dryRun: false };
}

async function waitForEmbedding(engine: PGLiteEngine): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const rows = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks WHERE embedded_at IS NOT NULL`);
    if (Number(rows[0]?.n) > 0) return;
    await Bun.sleep(25);
  }
  throw new Error('the queued embedding never ran');
}

const QUESTION = 'who wrote the zirconium needle retrieval fixture notes';

/** Expected receipt per mode; `null` token budget means no cap. */
const RECEIPTS: Record<SearchMode, {
  settings: { searchLimit: number; tokenBudget: number | null; reranker_enabled: boolean; reranker_top_n_in: number; expansion: boolean; contextual_retrieval: string };
  put_page: typeof calls; search: typeof calls; query: typeof calls;
}> = {
  conservative: {
    settings: { searchLimit: 10, tokenBudget: 4000, reranker_enabled: false, reranker_top_n_in: 30, expansion: false, contextual_retrieval: 'none' },
    put_page: { embed: 0, rerank: 0, expand: 0, chat: 0 },
    search: { embed: 1, rerank: 0, expand: 0, chat: 0 },
    query: { embed: 1, rerank: 0, expand: 0, chat: 0 },
  },
  balanced: {
    settings: { searchLimit: 25, tokenBudget: 12000, reranker_enabled: true, reranker_top_n_in: 25, expansion: false, contextual_retrieval: 'title' },
    put_page: { embed: 0, rerank: 0, expand: 0, chat: 0 },
    search: { embed: 1, rerank: 1, expand: 0, chat: 0 },
    query: { embed: 1, rerank: 1, expand: 0, chat: 0 },
  },
  tokenmax: {
    settings: { searchLimit: 50, tokenBudget: null, reranker_enabled: true, reranker_top_n_in: 50, expansion: false, contextual_retrieval: 'per_chunk_synopsis' },
    put_page: { embed: 0, rerank: 0, expand: 0, chat: 0 },
    search: { embed: 1, rerank: 1, expand: 0, chat: 0 },
    // No expansion call and no variant embeds since GBRA-94 (was embed 3, expand 1).
    query: { embed: 1, rerank: 1, expand: 0, chat: 0 },
  },
};

describe('fresh-init receipt per search mode', () => {
  for (const mode of ['conservative', 'balanced', 'tokenmax'] as const) {
    test(`${mode}: resolved settings and provider calls for one put_page, one search, one query`, async () => {
      const engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      try {
        const log = console.log;
        console.log = () => {};
        try { await runModePicker(engine, { explicit: mode }); } finally { console.log = log; }

        const resolved = resolveSearchMode({ mode, overrides: (await loadSearchModeConfig(engine)).overrides });
        const want = RECEIPTS[mode];
        expect({
          searchLimit: resolved.searchLimit, tokenBudget: resolved.tokenBudget ?? null, reranker_enabled: resolved.reranker_enabled,
          reranker_top_n_in: resolved.reranker_top_n_in, expansion: resolved.expansion, contextual_retrieval: resolved.contextual_retrieval as string,
        }).toEqual(want.settings);

        reset();
        const put = await operationsByName.put_page.handler(ctx(engine), {
          slug: 'notes/zirconium-needle',
          content: '---\ntype: note\ntitle: Zirconium Needle\n---\nThe zirconium needle retrieval fixture notes were written by alice-example.\n',
        });
        expect((put as { embedding_state?: string }).embedding_state).toBe('queued');
        expect({ ...calls }).toEqual(want.put_page);
        // The queued embedding drains in this process: one call for the page's chunk.
        await waitForEmbedding(engine);
        expect(calls.embed).toBe(1);

        reset();
        __clearQueryEmbedCacheForTests();
        const found = await operationsByName.search.handler(ctx(engine), { query: QUESTION });
        expect(JSON.stringify(found)).toContain('notes/zirconium-needle');
        expect({ ...calls }).toEqual(want.search);

        reset();
        __clearQueryEmbedCacheForTests();
        const answered = await operationsByName.query.handler(ctx(engine), { query: QUESTION });
        expect(JSON.stringify(answered)).toContain('notes/zirconium-needle');
        expect({ ...calls }).toEqual(want.query);
      } finally {
        await engine.disconnect();
      }
    }, 120_000);
  }
});
