/**
 * Per-stage search timings on the `search` and `query` operations
 * (`_meta.retrieval.timings`, src/core/search/stage-timings.ts): present on
 * clean, degraded, empty and keyword-only responses; op-layer work is timed;
 * a nested fan-out call is booked once; the parallel lexical arms stay
 * parallel; the fields never reach MCP content blocks.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import type { SearchTimingsMeta } from '../../src/core/search/stage-timings.ts';
import type { SearchResult } from '../../src/core/types.ts';

let engine: PGLiteEngine;
let lastMeta: Record<string, any> | null = null;
const op = (name: string) => operations.find(o => o.name === name)!;
const DIMS = 1536;

function ctx(): OperationContext {
  return {
    engine, config: {} as never, logger: console as never, dryRun: false, remote: false, sourceId: 'default',
    emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval') lastMeta = value as Record<string, any>; },
  } as OperationContext;
}

async function run(name: 'search' | 'query', params: Record<string, unknown>): Promise<{ rows: SearchResult[]; meta: Record<string, any>; timings: SearchTimingsMeta }> {
  lastMeta = null;
  const rows = await op(name).handler(ctx(), params) as SearchResult[];
  expect(lastMeta).not.toBeNull();
  return { rows, meta: lastMeta!, timings: lastMeta!.timings };
}

/** The timing contract every response carries. */
function expectTimings(t: SearchTimingsMeta | undefined): SearchTimingsMeta {
  expect(t).toBeDefined();
  const stages = Object.values(t!.stages_ms);
  for (const ms of [t!.total_ms, t!.other_ms, ...stages]) expect(Number.isInteger(ms) && ms >= 0).toBe(true);
  expect(stages.reduce((a, b) => a + b, 0) + t!.other_ms).toBe(t!.total_ms);
  return t!;
}

/** A deterministic unit vector from the text (no provider). */
function stubVector(text: string): number[] {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const out = Array.from({ length: DIMS }, (_, i) => Math.sin(h + i * 0.618));
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0));
  return out.map(v => v / norm);
}

/** A gateway that can embed (stub key + stub transport): the vector arms run. */
function withEmbeddings(): void {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'stub-not-a-key' } });
}

const stubTransport = (async (input: { values: string[] }) => ({ embeddings: input.values.map(stubVector) })) as never;

/** Swap the embed transport for one call; restore the stub after. */
async function withEmbedTransport<T>(transport: (input: { values: string[] }) => Promise<{ embeddings: number[][] }>, fn: () => Promise<T>): Promise<T> {
  __setEmbedTransportForTests(transport as never);
  try { return await fn(); } finally { __setEmbedTransportForTests(stubTransport); }
}

/** Delay both lexical engine reads on this engine instance; restore after. */
async function withSlowLexicalArms<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const keyword = engine.searchKeyword.bind(engine);
  const titles = engine.searchTitles.bind(engine);
  const delay = () => new Promise(resolve => setTimeout(resolve, ms));
  engine.searchKeyword = (async (...args: Parameters<typeof keyword>) => { await delay(); return keyword(...args); }) as typeof engine.searchKeyword;
  engine.searchTitles = (async (...args: Parameters<typeof titles>) => { await delay(); return titles(...args); }) as typeof engine.searchTitles;
  try { return await fn(); } finally { engine.searchKeyword = keyword; engine.searchTitles = titles; }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  __setEmbedTransportForTests(stubTransport);
  withEmbeddings();
  const pages: Array<[string, string]> = [
    ['notes/widget-roadmap', '---\ntitle: Widget roadmap\n---\nThe quarterly widget roadmap covers pricing, renewal dates and the launch plan.\n'],
    ['notes/renewal-memo', '---\ntitle: Renewal memo\n---\nThe renewal memo lists widget pricing tiers and the support handbook.\n'],
    ['companies/acme-example', '---\ntitle: "Customer: Acme Example"\n---\nAcme Example, account code: ACMEX, buys the widget bundle every quarter.\n'],
    ['notes/acmex-amendment', '---\ntitle: ACMEX amendment\n---\nAmendment for ACMEX: the bundle renewal moves to march.\n'],
  ];
  for (const [slug, md] of pages) await importFromContent(engine, slug, md, { sourceId: 'default' });
}, 120_000);

afterAll(async () => {
  resetGateway();
  await engine.disconnect();
});

describe('timings ride every search and query response', () => {
  test('hybrid search (embed, vector, fusion, rerank and op-layer stages), degraded by a keyless reranker', async () => {
    withEmbeddings();
    const { rows, meta, timings } = await run('search', { query: 'widget roadmap pricing' });
    expect(rows.length).toBeGreaterThan(0);
    expect(meta.vector_enabled).toBe(true);
    const t = expectTimings(timings);
    for (const stage of ['setup', 'lexical', 'relational', 'embed', 'vector', 'fuse', 'post_fusion', 'rerank', 'alias_fanout', 'anchoring', 'response']) {
      expect(t.stages_ms).toHaveProperty(stage);
    }
    expect(Object.keys(t.overlapped_ms ?? {}).sort()).toEqual(['embed', 'keyword_arm', 'keyword_count', 'title_arm', 'vector']);
  });

  test('query adds the facts arm and expansion stages', async () => {
    withEmbeddings();
    const t = expectTimings((await run('query', { query: 'widget roadmap pricing', expand: true })).timings);
    expect(t.stages_ms).toHaveProperty('facts_arm');
    expect(t.stages_ms).toHaveProperty('expansion');
    expect(t.stages_ms).toHaveProperty('vector');
  });

  test('a keyless brain: degraded keyword-only responses carry the fields', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: {} });
    for (const name of ['search', 'query'] as const) {
      const { meta, timings } = await run(name, { query: 'widget roadmap' });
      expect(meta.degraded.map((d: { stage: string }) => d.stage)).toContain('embed_unavailable');
      const t = expectTimings(timings);
      expect(t.stages_ms).toHaveProperty('lexical');
      expect(t.stages_ms).not.toHaveProperty('vector');
    }
  });

  test('empty responses carry the fields', async () => {
    for (const name of ['search', 'query'] as const) {
      const { rows, timings } = await run(name, { query: 'zyzzyva quokkaflux' });
      expect(rows).toEqual([]);
      expectTimings(timings);
    }
  });

  test('the search.mcp_keyword_only path carries the fields', async () => {
    await engine.setConfig('search.mcp_keyword_only', 'true');
    try {
      const t = expectTimings((await run('search', { query: 'widget roadmap' })).timings);
      expect(Object.keys(t.stages_ms)).toEqual(expect.arrayContaining(['setup', 'lexical', 'post_fusion', 'response']));
    } finally {
      await engine.setConfig('search.mcp_keyword_only', 'false');
    }
  });
});

describe('critical-path accounting', () => {
  test('the parallel lexical arms stay parallel: one delay of lexical time, both arms overlapped', async () => {
    withEmbeddings();
    const DELAY = 300;
    const started = performance.now();
    const t = expectTimings((await withSlowLexicalArms(DELAY, () => run('search', { query: 'widget pricing' }))).timings);
    const wall = performance.now() - started;
    expect(t.overlapped_ms!.keyword_arm).toBeGreaterThanOrEqual(DELAY - 5);
    expect(t.overlapped_ms!.title_arm).toBeGreaterThanOrEqual(DELAY - 5);
    expect(t.stages_ms.lexical).toBeGreaterThanOrEqual(DELAY - 5);
    expect(t.stages_ms.lexical).toBeLessThan(2 * DELAY - 20);
    expect(wall).toBeLessThan(2 * DELAY + t.total_ms - t.stages_ms.lexical!);
  });

  test('the query embed runs alongside the lexical arms: one delay of wall time, not two', async () => {
    withEmbeddings();
    const DELAY = 300;
    const slowEmbed = async (input: { values: string[] }) => {
      await new Promise(resolve => setTimeout(resolve, DELAY));
      return { embeddings: input.values.map(stubVector) };
    };
    const t = expectTimings((await withEmbedTransport(slowEmbed, () => withSlowLexicalArms(DELAY, () => run('search', { query: 'widget pricing' })))).timings);
    expect(t.stages_ms.lexical).toBeGreaterThanOrEqual(DELAY - 5);
    expect(t.overlapped_ms!.embed).toBeGreaterThanOrEqual(DELAY - 50);
    expect(t.stages_ms.embed! + t.overlapped_ms!.embed).toBeGreaterThanOrEqual(DELAY - 5);
    expect(t.total_ms).toBeLessThan(2 * DELAY - 50);
  });

  test('degraded stamps keep the sequential order when the vector side fails first', async () => {
    withEmbeddings();
    const keyword = engine.searchKeyword.bind(engine);
    engine.searchKeyword = (async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      throw new Error('keyword arm down (simulated)');
    }) as typeof engine.searchKeyword;
    try {
      const failingEmbed = async () => { throw new Error('embed provider down (simulated)'); };
      const { meta } = await withEmbedTransport(failingEmbed, () => run('search', { query: 'widget pricing' }));
      const stages = meta.degraded.map((d: { stage: string }) => d.stage);
      expect(stages).toContain('keyword_arm_failed');
      expect(stages).toContain('embed_unavailable');
      expect(stages.indexOf('keyword_arm_failed')).toBeLessThan(stages.indexOf('embed_unavailable'));
    } finally {
      engine.searchKeyword = keyword;
    }
  });

  test("an alias fan-out's keyword search is booked under alias_fanout, outside lexical and the arms", async () => {
    withEmbeddings();
    const DELAY = 150;
    const { meta, timings } = await withSlowLexicalArms(DELAY, () => run('search', { query: 'Acme Example bundle renewal' }));
    expect(meta.fanout?.aliases_searched?.map((n: { alias: string }) => n.alias)).toContain('ACMEX');
    const t = expectTimings(timings);
    expect(t.stages_ms.alias_fanout).toBeGreaterThanOrEqual(DELAY - 5);
    expect(t.stages_ms.lexical).toBeGreaterThanOrEqual(DELAY - 5);
    expect(t.stages_ms.lexical).toBeLessThan(2 * DELAY - 20);
    expect(t.overlapped_ms!.keyword_arm).toBeLessThan(2 * DELAY - 20);
  });

  test('timings stay out of MCP content blocks and ride _meta.retrieval', async () => {
    withEmbeddings();
    const res = await dispatchToolCall(engine as never, 'search', { query: 'widget roadmap' }, { remote: true, transport: 'stdio', sourceId: 'default' });
    const timings = (res._meta?.retrieval as Record<string, unknown> | undefined)?.timings as SearchTimingsMeta;
    expectTimings(timings);
    const content = JSON.stringify(res.content);
    for (const needle of ['timings', 'total_ms', 'stages_ms', 'overlapped_ms', 'other_ms']) expect(content).not.toContain(needle);
  });
});
