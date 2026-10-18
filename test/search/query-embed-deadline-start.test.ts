/**
 * #6400 (a): the query-embed deadline starts at the first embed request.
 *
 * Protects: slow lexical work or expansion before the vector arm must not
 * spend the embed budget, so a healthy embed after a slow keyword arm still
 * gets the full QUERY_EMBED_TIMEOUT_MS instead of the 2 s floor. Fails when
 * the deadline is created at hybridSearchCached entry (master before the fix).
 * The clock jump is injected in the keyword arm; AbortSignal.timeout records
 * the budget embedQueryBounded grants. PGLite in-memory; embed transport stubbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { hybridSearchCached, lazyQueryEmbedDeadline } from '../../src/core/search/hybrid.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await importFromContent(engine, 'notes/widget-roadmap',
    '---\ntype: note\ntitle: Widget roadmap\n---\n\nThe widget roadmap covers the next release.\n', { noEmbed: true });
}, 60_000);

afterAll(async () => { await engine?.disconnect(); }, 60_000);

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('query-embed deadline start (#6400 a)', () => {
  test('lazyQueryEmbedDeadline starts on the first call and returns the same deadline after', async () => {
    const get = lazyQueryEmbedDeadline(6_000);
    await new Promise(resolve => setTimeout(resolve, 50));
    const before = Date.now();
    const first = get();
    expect(first.deadlineAt).toBeGreaterThanOrEqual(before + 6_000);
    expect(get()).toBe(first);
  });

  test('a slow keyword arm does not spend the vector arm embed budget', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
    let embeds = 0;
    __setEmbedTransportForTests((async (args: { values: string[] }) => {
      embeds += args.values.length;
      return { embeddings: args.values.map(() => Array.from({ length: 1536 }, () => 0.01)) };
    }) as never);
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const now = spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    const budgets: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { budgets.push(ms); return realTimeout(ms); });
    const searchKeyword = engine.searchKeyword.bind(engine);
    const keyword = spyOn(engine, 'searchKeyword').mockImplementation(async (...args: Parameters<PGLiteEngine['searchKeyword']>) => {
      offset += 10_000; // the keyword arm "took" 10 s
      return searchKeyword(...args);
    });
    try {
      await hybridSearchCached(engine, 'widget roadmap', { expansion: false, limit: 5 } as never);
    } finally {
      keyword.mockRestore();
      timeout.mockRestore();
      now.mockRestore();
    }
    expect(embeds).toBeGreaterThan(0);
    // embedQueryBounded's own budget: the full default, not the 2 s floor.
    expect(budgets.some(ms => ms >= 5_000)).toBe(true);
    expect(budgets).not.toContain(2_000);
  });
});
