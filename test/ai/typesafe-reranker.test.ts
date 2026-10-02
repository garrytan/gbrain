/**
 * S1: `search.reranker.model typesafe:jev-1.13.0` through the decide core.
 * Ports the #5178 reranker contract (credit: dsandrade): native System One
 * score questions, bearer auth, normalized four-level scores, stable ties,
 * batch-local indices merged globally, topN after all batches, no truncation,
 * bounded concurrency, status-only errors, budget accounting and fail-open
 * through applyReranker. Adds the resolved-model check (mixed ids fail open)
 * and the JEV_TYPESAFE_API_KEY alias.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureGateway, resetGateway, rerank, RerankError, __setRerankTransportForTests, withBudgetTracker, type RerankMeta,
} from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { rerankerReadiness } from '../../src/core/ai/reranker-readiness.ts';
import { DEFAULT_RERANKER_MODEL } from '../../src/core/ai/defaults.ts';
import { BudgetTracker } from '../../src/core/budget/budget-tracker.ts';
import { applyReranker } from '../../src/core/search/rerank.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { estimateContextTokens, planBatches } from '../../src/core/ai/decide/pack.ts';
import { rerankQuestions } from '../../src/core/ai/decide/rerank-adapter.ts';
import { parseTypeSafeResponse, toWireQuestion } from '../../src/core/ai/decide/providers/typesafe.ts';

const MODEL = 'typesafe:jev-1.13.0';
const longDocuments = (count: number) => Array.from({ length: count }, (_, i) => `candidate ${i}: ${'evidence '.repeat(500)}`);
const queuedDocuments = () => Array.from({ length: 280 }, () => 'evidence '.repeat(2000));
function configure(env: Record<string, string> = { TYPESAFE_API_KEY: 'sk-test-typesafe' }): void {
  configureGateway({ reranker_model: MODEL, env });
}
function response(scores: number[], tokens = 100, model = 'jev-1.13.0'): Response {
  return new Response(JSON.stringify({
    model,
    answers: Object.fromEntries(scores.map((score, i) => [`document_${i}`, { type: 'score', score, confidence: 0.9 }])),
    usage: { input_tokens: tokens, output_tokens: 12 },
  }), { headers: { 'content-type': 'application/json' } });
}
function docsFromBody(body: any): string[] { return Object.values(body.questions).map((q: any) => q.instructions.candidate); }
function docsFor(init: RequestInit): string[] { return docsFromBody(JSON.parse(init.body as string)); }
/** Answer every question id the request carries (ids are stable across batches: document_<global index>). */
function answerBody(init: RequestInit, score: (doc: string) => number, tokens = 100, model = 'jev-1.13.0'): Response {
  const body = JSON.parse(init.body as string);
  return new Response(JSON.stringify({
    model,
    answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => [id, { type: 'score', score: score(q.instructions.candidate), confidence: 0.9 }])),
    usage: { input_tokens: tokens, output_tokens: 12 },
  }), { headers: { 'content-type': 'application/json' } });
}
const batchCount = (documents: string[]) => planBatches(estimateContextTokens({ query: 'q' }), rerankQuestions(documents).map((q) => estimateContextTokens(toWireQuestion(q)))).length;

afterEach(() => {
  __setRerankTransportForTests(null);
  resetGateway();
});

describe('System One reranker (S1)', () => {
  test('registers decide + reranker touchpoints only and leaves the default reranker unchanged', () => {
    const recipe = getRecipe('typesafe')!;
    expect(recipe.auth_env?.required).toEqual(['TYPESAFE_API_KEY']);
    expect(recipe.touchpoints.reranker?.models).toContain('jev-1.13.0');
    expect(recipe.touchpoints.decide?.default_model).toBe('jev-1.13.0');
    expect(recipe.touchpoints.embedding).toBeUndefined();
    expect(recipe.touchpoints.chat).toBeUndefined();
    expect(DEFAULT_RERANKER_MODEL).toBe('voyage:rerank-2.5');
    expect(rerankerReadiness(MODEL, {}).ready).toBe(false);
    expect(rerankerReadiness(MODEL, { TYPESAFE_API_KEY: 'sk-test' }).ready).toBe(true);
    expect(rerankerReadiness(MODEL, { JEV_TYPESAFE_API_KEY: 'sk-test' }).ready).toBe(true);
  });

  test('sends native System One score questions with bearer auth and normalizes fractional scores', async () => {
    configure();
    __setRerankTransportForTests(async (url, init) => {
      expect(url).toBe('https://api.typesafe.ai/v1/systemone');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-test-typesafe');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('jev-1.13.0');
      expect(body.state).toEqual({ query: 'Which launch decision was made?' });
      expect(docsFromBody(body)).toEqual(['routine', 'decision', 'background']);
      expect(body.questions.document_1.instructions.task).toContain('`candidate`');
      expect(body.questions.document_1.type).toBe('score');
      expect(body.questions.document_1.criteria).toHaveLength(4);
      expect(body.top_n).toBeUndefined();
      return response([0, 2.7, 1.2]);
    });
    expect(await rerank({ query: 'Which launch decision was made?', documents: ['routine', 'decision', 'background'], topN: 2 }))
      .toEqual([{ index: 1, relevanceScore: 0.9 }, { index: 2, relevanceScore: 1.2 / 3 }]);
  });

  test('accepts JEV_TYPESAFE_API_KEY as the credential', async () => {
    configure({ JEV_TYPESAFE_API_KEY: 'sk-test-alias' });
    __setRerankTransportForTests(async (_url, init) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-test-alias');
      return response([3]);
    });
    expect(await rerank({ query: 'q', documents: ['d'] })).toEqual([{ index: 0, relevanceScore: 1 }]);
  });

  test('merges batch-local indices globally and applies topN after all batches', async () => {
    configure();
    const documents = longDocuments(66);
    let calls = 0;
    __setRerankTransportForTests(async (_url, init) => {
      calls++;
      return answerBody(init, (doc) => (doc.startsWith('candidate 65:') ? 3 : 1));
    });
    const result = await rerank({ query: 'q', documents, topN: 3 });
    expect(calls).toBe(batchCount(documents));
    expect(calls).toBeGreaterThan(1);
    expect(result.map((r) => r.index)).toEqual([65, 0, 1]);
  });

  test('packs fifty short candidates into one request', () => {
    const documents = Array.from({ length: 50 }, () => 'Useful background evidence. '.repeat(35));
    expect(batchCount(documents)).toBe(1);
  });

  test('reports the resolved model and rubric semantics through onMeta', async () => {
    configure();
    __setRerankTransportForTests(async () => response([2], 77, 'jev-1.13.0'));
    let meta: RerankMeta | undefined;
    await rerank({ query: 'q', documents: ['d'], onMeta: (m) => { meta = m; } });
    expect(meta).toMatchObject({ model_resolved: 'jev-1.13.0', score_semantics: 'rubric', input_tokens: 77, batches: 1 });
  });

  test('mixed resolved models across the batches of one call fail it open (the #5178 review gap)', async () => {
    configure();
    let calls = 0;
    __setRerankTransportForTests(async (_url, init) => {
      calls++;
      return answerBody(init, () => 1, 100, calls === 1 ? 'jev-1.13.0' : 'jev-1.14.0');
    });
    await expect(rerank({ model: 'typesafe:jev-latest', query: 'q', documents: longDocuments(66) }))
      .rejects.toMatchObject({ reason: 'unknown', message: expect.stringContaining('mixed_model') });
  });

  test('a response without a resolved model is malformed', async () => {
    configure();
    __setRerankTransportForTests(async () => new Response(JSON.stringify({ answers: { document_0: { type: 'score', score: 3 } } })));
    await expect(rerank({ query: 'q', documents: ['d'] })).rejects.toBeInstanceOf(RerankError);
  });

  for (const answer of [undefined, { type: 'choice', choice: 'yes' }, { type: 'score', score: '3' },
    { type: 'score', score: -1 }, { type: 'score', score: 3.1 }, { type: 'score', score: Infinity }]) {
    test(`rejects missing or invalid scores (${JSON.stringify(answer)})`, () => {
      expect(() => parseTypeSafeResponse({ model: 'jev-1.13.0', answers: { document_0: answer } }, rerankQuestions(['d']))).toThrow();
    });
  }

  test('digit-dense and Unicode input splits without dropping or truncating evidence', async () => {
    configure();
    const documents = Array.from({ length: 10 }, (_, i) => `${i}: ${'1234567890漢字🧠'.repeat(900)}`);
    const seen: string[] = [];
    __setRerankTransportForTests(async (_url, init) => { seen.push(...docsFor(init)); return answerBody(init, () => 1); });
    await rerank({ query: 'q', documents });
    expect(batchCount(documents)).toBeGreaterThan(1);
    expect([...seen].sort()).toEqual([...documents].sort());
  });

  test('oversized single pairs fail before any HTTP request', async () => {
    configure();
    let calls = 0;
    __setRerankTransportForTests(async () => { calls++; return response([3]); });
    await expect(rerank({ query: 'word '.repeat(20_000), documents: ['d'] })).rejects.toMatchObject({ reason: 'payload_too_large' });
    expect(calls).toBe(0);
  });

  test('missing key skips transport rather than changing providers', async () => {
    configure({});
    let calls = 0;
    __setRerankTransportForTests(async () => { calls++; return response([3]); });
    await expect(rerank({ query: 'q', documents: ['d'] })).rejects.toMatchObject({ reason: 'no_key' });
    expect(calls).toBe(0);
  });

  for (const [status, reason] of [[401, 'auth'], [429, 'rate_limit'], [529, 'network']] as const) {
    test(`classifies HTTP ${status} without leaking echoed evidence`, async () => {
      configure();
      __setRerankTransportForTests(async () => new Response('private-source-marker', { status }));
      try { await rerank({ query: 'q', documents: ['d'] }); throw new Error('expected failure'); }
      catch (err) {
        expect(err).toBeInstanceOf(RerankError);
        expect((err as RerankError).reason).toBe(reason);
        expect((err as Error).message).not.toContain('private-source-marker');
      }
    });
  }

  test('429 retry-after is honored only when it fits the deadline', async () => {
    configure();
    let calls = 0;
    __setRerankTransportForTests(async () => {
      calls++;
      return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : response([3]);
    });
    expect(await rerank({ query: 'q', documents: ['d'] })).toEqual([{ index: 0, relevanceScore: 1 }]);
    expect(calls).toBe(2);
    calls = 0;
    __setRerankTransportForTests(async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '60' } }); });
    await expect(rerank({ query: 'q', documents: ['d'], timeoutMs: 1000 })).rejects.toMatchObject({ reason: 'rate_limit' });
    expect(calls).toBe(1);
  });

  test('malformed JSON does not echo private response contents', async () => {
    configure();
    __setRerankTransportForTests(async () => new Response('private-source-marker'));
    await expect(rerank({ query: 'q', documents: ['d'] })).rejects.toMatchObject({ reason: 'unknown', message: 'TypeSafe rerank: malformed JSON' });
  });

  test('overall timeout aborts started calls and does not start later batches', async () => {
    configure();
    let calls = 0;
    __setRerankTransportForTests(async (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
    });
    await expect(rerank({ query: 'q', documents: queuedDocuments(), timeoutMs: 15 })).rejects.toMatchObject({ reason: 'timeout' });
    expect(calls).toBe(16);
  });

  test('an already-aborted caller sends no request', async () => {
    configure();
    let calls = 0;
    __setRerankTransportForTests(async () => { calls++; return response([3]); });
    const ctrl = new AbortController(); ctrl.abort();
    await expect(rerank({ query: 'q', documents: ['d'], signal: ctrl.signal })).rejects.toBeInstanceOf(RerankError);
    expect(calls).toBe(0);
  });

  test('records reported input usage from every batch as one rerank call', async () => {
    configure();
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-typesafe-budget-'));
    try {
      const tracker = new BudgetTracker({ label: 'test', maxCostUsd: 1, auditPath: join(dir, 'audit.jsonl') });
      __setRerankTransportForTests(async (_url, init) => answerBody(init, () => 1, 321));
      await withBudgetTracker(tracker, () => rerank({ query: 'q', documents: longDocuments(66) }));
      expect(tracker.snapshot().cumulativeCostUsd).toBeCloseTo((321 * batchCount(longDocuments(66))) * 0.042 / 1_000_000, 12);
      expect(tracker.snapshot().callsRecorded).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a failed batch settles usage from all started calls and stops queued batches', async () => {
    configure();
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-typesafe-partial-'));
    try {
      const tracker = new BudgetTracker({ label: 'test', maxCostUsd: 1, auditPath: join(dir, 'audit.jsonl') });
      let calls = 0;
      __setRerankTransportForTests(async (_url, init) => {
        calls++;
        return calls === 1 ? response([], 100) : answerBody(init, () => 2);
      });
      await expect(withBudgetTracker(tracker, () => rerank({ query: 'q', documents: queuedDocuments() }))).rejects.toMatchObject({ reason: 'unknown' });
      expect(calls).toBe(16);
      expect(tracker.snapshot().cumulativeCostUsd).toBeCloseTo(1600 * 0.042 / 1_000_000, 12);
      expect(tracker.snapshot().callsRecorded).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('budget denial happens before transport', async () => {
    configure();
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-typesafe-denied-'));
    try {
      let calls = 0;
      const tracker = new BudgetTracker({ label: 'test', maxCostUsd: 0, auditPath: join(dir, 'audit.jsonl') });
      __setRerankTransportForTests(async () => { calls++; return response([3]); });
      await expect(withBudgetTracker(tracker, () => rerank({ query: 'q', documents: ['d'] }))).rejects.toMatchObject({ tag: 'BUDGET_EXHAUSTED' });
      expect(calls).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('one failed batch preserves all search results and original scores (fail open)', async () => {
    configure();
    const results = Array.from({ length: 40 }, (_, i) => ({ slug: `notes/candidate-${i}`, chunk_text: `d${i}`, title: 'Candidate', score: 40 - i })) as SearchResult[];
    const before = structuredClone(results);
    __setRerankTransportForTests(async (_url, init) => docsFor(init).includes('d32')
      ? new Response('{"answers":{}}', { headers: { 'content-type': 'application/json' } })
      : answerBody(init, () => 3));
    expect(await applyReranker('q', results, { enabled: true, topNIn: 34, topNOut: null, model: MODEL })).toEqual(before);
  });

  test('stamps rubric semantics so autocut and CRAG do not consume the level score', async () => {
    configure();
    const results = [0, 1].map((i) => ({ slug: `notes/c${i}`, chunk_text: `d${i}`, title: 'C', score: 2 - i })) as SearchResult[];
    __setRerankTransportForTests(async () => response([1, 3]));
    const out = await applyReranker('q', results, { enabled: true, topNIn: 2, topNOut: null, model: MODEL });
    expect(out.map((r) => r.slug)).toEqual(['notes/c1', 'notes/c0']);
    expect(out.every((r) => r.rerank_score_kind === 'rubric')).toBe(true);
  });

  test('keeps the ordinary Voyage wire unchanged when a TypeSafe key also exists', async () => {
    configureGateway({ reranker_model: 'voyage:rerank-2.5', env: { VOYAGE_API_KEY: 'sk-test-voyage', TYPESAFE_API_KEY: 'sk-test-typesafe' } });
    __setRerankTransportForTests(async (url, init) => {
      expect(url).toBe('https://api.voyageai.com/v1/rerank');
      expect(JSON.parse(init.body as string)).toEqual({ model: 'rerank-2.5', query: 'q', documents: ['d'], top_k: 1 });
      return new Response('{"data":[{"index":0,"relevance_score":0.8}]}');
    });
    const out = await rerank({ query: 'q', documents: ['d'], topN: 1 });
    expect(out).toEqual([{ index: 0, relevanceScore: 0.8 }]);
  });
});
