import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { SearchResult } from '../../src/core/types.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { decodeDeepResearchId } from '../../src/core/deep-research-id.ts';

const syntheticKey = 'sk-proj-' + 'syntheticonlyab19'.repeat(4);
const syntheticBearer = 'SyntheticBearerOnlyAb19'.repeat(2);
const content = `Synthetic credential ${syntheticKey}; Authorization: Bearer ${syntheticBearer}`;
let rows: SearchResult[] = [];
let thinkAnswer = '';
let capturedRows: SearchResult[][] = [];
const actualCapture = await import('../../src/core/eval-capture.ts');
mock.module('../../src/core/eval-capture.ts', () => ({
  ...actualCapture,
  captureEvalCandidate: async (_engine: unknown, input: { results: SearchResult[] }) => { capturedRows.push(input.results); },
}));
const actualHybrid = await import('../../src/core/search/hybrid.ts');
const originalHybridSearch = actualHybrid.hybridSearchCached;
mock.module('../../src/core/search/hybrid.ts', () => ({
  ...actualHybrid,
  hybridSearchCached: async (engine: Parameters<typeof originalHybridSearch>[0], query: string, opts: NonNullable<Parameters<typeof originalHybridSearch>[2]>) => {
    if (query.startsWith('notes/')) return originalHybridSearch(engine, query, opts);
    opts.onMeta?.({ vector_enabled: true, detail_resolved: null, expansion_applied: false,
      degraded: [{ stage: 'reranker_skipped', reason: content }] } as any);
    return rows;
  },
}));
const actualGateway = await import('../../src/core/ai/gateway.ts');
mock.module('../../src/core/ai/gateway.ts', () => ({
  ...actualGateway,
  embedMultimodal: async () => [[0.1, 0.2]],
}));
const actualThink = await import('../../src/core/think/index.ts');
mock.module('../../src/core/think/index.ts', () => ({
  ...actualThink,
  runThink: async () => ({ answer: thinkAnswer, citations: [], modelUsed: 'synthetic-model' }),
}));

const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
const { operationsByName } = await import('../../src/core/operations.ts');
const { formatResult, captureRetrievalMeta, resetRetrievalMetaForTests } = await import('../../src/cli.ts');
const { getCliOptions, setCliOptions, _resetCliOptionsForTest } = await import('../../src/core/cli-options.ts');
const { resetPgliteState } = await import('../helpers/reset-pglite.ts');
const { installFixtureChunks } = await import('../helpers/page-projection.ts');
let engine: InstanceType<typeof PGLiteEngine>;

function row(): SearchResult {
  return {
    slug: `notes/${syntheticKey}`, source_id: 'default', page_id: 999999, title: content,
    type: 'note', chunk_text: content, chunk_source: 'compiled_truth', chunk_id: 1,
    chunk_index: 0, score: 0.7, stale: false, source_subject: content,
    content_flag: { reason: 'synthetic', detail: content }, status: content,
  };
}

function context(remote = true) {
  const meta: Record<string, any> = {};
  const ctx: OperationContext = {
    engine, remote, sourceId: 'default', config: { engine: 'pglite' }, dryRun: false,
    logger: { info() {}, warn() {}, error() {} },
    emitResponseMeta: (key, value) => { meta[key] = value; },
  };
  return { ctx, meta };
}

function expectScrubbed(result: SearchResult) {
  for (const value of [result.title, result.chunk_text, result.source_subject, result.status, result.content_flag?.detail]) {
    expect(value?.includes(syntheticKey)).toBe(false);
    expect(value?.includes(syntheticBearer)).toBe(false);
    expect(value).toContain('<REDACTED:');
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);
beforeEach(async () => {
  await resetPgliteState(engine);
  rows = [row()];
  thinkAnswer = content;
  capturedRows = [];
  resetRetrievalMetaForTests();
  _resetCliOptionsForTest();
});
afterAll(async () => { await engine.disconnect(); });

describe('retrieval output boundary', () => {
  test('search and CLI retain incomplete retrieval diagnostics after exhausting the text scan budget', async () => {
    await engine.setConfig('search.mcp_keyword_only', 'true');
    await engine.putPage('notes/pending-projection', { type: 'note', title: 'Pending projection', compiled_truth: 'Unprojected fixture.' });
    rows = Array.from({ length: 100 }, (_, index) => ({
      ...row(), slug: `notes/large-${index}`, title: 'a'.repeat(16000), chunk_text: 'b'.repeat(16000), source_subject: 'c'.repeat(1000),
    }));
    const keyword = spyOn(engine, 'searchKeyword').mockResolvedValue(rows);
    try {
      const { ctx, meta } = context(false);
      const result = await operationsByName.search.handler(ctx, { query: 'fixture', limit: 100 }) as SearchResult[];
      expect(result).toHaveLength(rows.length);
      expect(meta.retrieval.degraded).toContainEqual({ stage: 'projection_pending' });
      expect(meta.retrieval.projection_readiness).toMatchObject({ status: 'projection_pending', ready: false });
      captureRetrievalMeta('retrieval', meta.retrieval);
      expect(formatResult('search', result)).toContain('Retrieval incomplete: projection_pending.');
      captureRetrievalMeta('retrieval', { degraded: [{ stage: 'projection_pending' }], projection_readiness: { status: 'projection_pending', ready: false } });
      expect(formatResult('search', rows)).toContain('Retrieval incomplete: projection_pending.');
    } finally { keyword.mockRestore(); }
  });

  test('real keyword retrieval redacts a sealed projection while its canonical page and chunks stay intact', async () => {
    await engine.setConfig('search.mcp_keyword_only', 'true');
    await engine.putPage('notes/synthetic-keyword', {
      type: 'note', title: 'Synthetic keyword fixture', compiled_truth: content,
    });
    await installFixtureChunks(engine, 'notes/synthetic-keyword', [{
      chunk_index: 0, chunk_text: content, chunk_source: 'compiled_truth',
    }]);
    const { ctx, meta } = context();
    const result = await operationsByName.search.handler(ctx, { query: 'synthetic credential' }) as SearchResult[];
    expect(result).toHaveLength(1);
    expect(result[0].chunk_text.includes(syntheticKey)).toBe(false);
    expect(result[0].chunk_text.includes(syntheticBearer)).toBe(false);
    expect(result[0].chunk_text).toContain('<REDACTED:');
    expect((await engine.searchKeyword('synthetic credential', { sourceId: 'default' }))[0].chunk_text).toBe(content);
    expect((await engine.getPage('notes/synthetic-keyword', { sourceId: 'default' }))?.compiled_truth).toBe(content);
    expect(meta.retrieval.projection_readiness).toEqual({ status: 'ready', ready: true });
  });

  test('keyword output redacts all display fields without mutating engine-owned rows', async () => {
    await engine.setConfig('search.mcp_keyword_only', 'true');
    const original = structuredClone(rows);
    Object.freeze(rows[0]);
    const keyword = spyOn(engine, 'searchKeyword').mockResolvedValue(rows);
    try {
      const { ctx, meta } = context();
      const result = await operationsByName.search.handler(ctx, { query: 'synthetic' }) as SearchResult[];
      expectScrubbed(result[0]);
      expect(rows).toEqual(original);
      expect(result[0].slug).toBe(original[0].slug);
      expect(result[0].score).toBe(original[0].score);
      expect(meta.retrieval.projection_readiness).toEqual({ status: 'ready', ready: true });
    } finally { keyword.mockRestore(); }
  });

  test.each(['search', 'query'])('%s hybrid scrubs metadata and preserves identity, ranking and internal content', async op => {
    const original = structuredClone(rows);
    Object.freeze(rows[0]);
    const { ctx, meta } = context();
    const result = await operationsByName[op].handler(ctx, { query: 'synthetic', expand: false }) as SearchResult[];
    expectScrubbed(result[0]);
    expect(rows).toEqual(original);
    expect(result[0].slug).toBe(original[0].slug);
    expect(result[0].score).toBe(original[0].score);
    expect(decodeDeepResearchId((result[0] as any).id)).toEqual({ sourceId: 'default', slug: original[0].slug });
    expect(JSON.stringify(meta).includes(syntheticKey)).toBe(false);
    expect(JSON.stringify(meta).includes(syntheticBearer)).toBe(false);
    expect(meta.retrieval.returned_count).toBe(1);
  });

  test('image query redacts output without mutating vector rows', async () => {
    const original = structuredClone(rows);
    Object.freeze(rows[0]);
    const vector = spyOn(engine, 'searchVector').mockResolvedValue(rows);
    try {
      const { ctx } = context();
      const result = await operationsByName.query.handler(ctx, { image: 'c3ludGhldGlj', image_mime: 'image/png' }) as SearchResult[];
      expectScrubbed(result[0]);
      expect(rows).toEqual(original);
    } finally { vector.mockRestore(); }
  });

  test('exact lookup redacts a real canonical page only at output and keeps readiness honest', async () => {
    await engine.putPage('notes/synthetic-redaction', {
      type: 'note', title: 'Synthetic fixture', compiled_truth: content,
    });
    const { ctx, meta } = context(false);
    const result = await operationsByName.query.handler(ctx, { query: 'notes/synthetic-redaction', expand: false }) as SearchResult[];
    expect(result[0].exact_lookup).toBe('slug');
    expect(result[0].chunk_text.includes(syntheticKey)).toBe(false);
    expect(result[0].chunk_text).toContain('<REDACTED:');
    expect((await engine.getPage('notes/synthetic-redaction', { sourceId: 'default' }))?.compiled_truth).toBe(content);
    expect(meta.retrieval.crag.confidence).toBe('strong');
    expect(meta.retrieval.projection_readiness.status).toBe('projection_pending');
  });

  test('CRAG answer and earlier bare echoes share one output redaction dictionary', async () => {
    await engine.setConfig('search.crag_think', 'true');
    rows[0].rerank_score = 0.01;
    rows[0].chunk_text = syntheticBearer;
    const { ctx, meta } = context(false);
    const result = await operationsByName.query.handler(ctx, { query: 'synthetic', expand: false }) as SearchResult[];
    expect(result[0].chunk_text.includes(syntheticBearer)).toBe(false);
    expect(meta.retrieval.crag.think.answer.includes(syntheticKey)).toBe(false);
    expect(meta.retrieval.crag.think.answer.includes(syntheticBearer)).toBe(false);
    expect(thinkAnswer).toBe(content);
    expect(rows[0].chunk_text).toBe(syntheticBearer);
  });

  test.each(['search', 'query'])('%s eval capture retains internal pre-redaction text', async op => {
    const { ctx } = context();
    ctx.config = { engine: 'pglite', eval: { capture: true } };
    const result = await operationsByName[op].handler(ctx, { query: 'synthetic', expand: false, snippet_chars: 12 }) as SearchResult[];
    expect(capturedRows).toHaveLength(1);
    expect(capturedRows[0][0].chunk_text).toBe(content);
    expect(result[0].chunk_text.startsWith(content.slice(0, 20))).toBe(false);
  });

  test('redacts before snippet truncation can cut through a credential', async () => {
    rows[0].slug = 'notes/synthetic';
    rows[0].chunk_text = syntheticKey + ' safe suffix';
    const { ctx } = context();
    const result = await operationsByName.search.handler(ctx, { query: 'synthetic', snippet_chars: 12 }) as SearchResult[];
    expect(result[0].chunk_text.includes(syntheticKey.slice(0, 12))).toBe(false);
    expect(result[0].chunk_text.startsWith('<REDACTED:')).toBe(true);
    expect(rows[0].chunk_text).toBe(syntheticKey + ' safe suffix');
  });

  test.each(['search', 'query'])('CLI %s JSON, explain and human formats scrub older-server rows', op => {
    rows[0].slug = 'notes/synthetic';
    const original = structuredClone(rows);
    const metadata = { degraded: [{ stage: 'reranker_skipped', reason: content }] };
    captureRetrievalMeta('retrieval', metadata);
    const json = JSON.parse(formatResult(op, rows, { json: true }));
    expectScrubbed(json[0]);
    const human = formatResult(op, rows);
    expect(human.includes(syntheticKey.slice(0, 20))).toBe(false);
    setCliOptions({ ...getCliOptions(), explain: true });
    const explain = formatResult(op, rows);
    expect(explain.includes(syntheticKey)).toBe(false);
    expect(explain.includes(syntheticBearer)).toBe(false);
    expect(rows).toEqual(original);
    expect(metadata.degraded[0].reason).toBe(content);
  });
});
