import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureGateway, resetGateway, rerank, RerankError,
  __setRerankTransportForTests, withBudgetTracker,
} from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { rerankerReadiness } from '../../src/core/ai/reranker-readiness.ts';
import { mergedProviderEnv } from '../../src/core/ai/provider-env.ts';
import { loadGbrainEnvFile } from '../../src/core/gbrain-env-file.ts';
import { DEFAULT_RERANKER_MODEL } from '../../src/core/ai/defaults.ts';
import { BudgetTracker } from '../../src/core/budget/budget-tracker.ts';
import { applyReranker } from '../../src/core/search/rerank.ts';
import type { SearchResult } from '../../src/core/types.ts';
import {
  buildTypeSafeRerankBatches,
  executeTypeSafeRerankBatches, parseTypeSafeRerankResponse, TypeSafeContextError,
} from '../../src/core/ai/rerank-typesafe.ts';
import { withEnv } from '../helpers/with-env.ts';

const MODEL = 'typesafe:jev-1.13.0';
const longDocuments = (count: number) => Array.from({ length: count }, (_, i) => `candidate ${i}: ${'evidence '.repeat(500)}`);
const queuedDocuments = () => Array.from({ length: 280 }, () => 'evidence '.repeat(2000));
function configure(key = 'sk-test-typesafe'): void {
  configureGateway({ reranker_model: MODEL, env: key ? { TYPESAFE_API_KEY: key } : {} });
}
function response(scores: number[], tokens = 100): Response {
  return new Response(JSON.stringify({
    model: 'jev-1.13.0',
    answers: Object.fromEntries(scores.map((score, i) => [`document_${i}`, { type: 'score', score }])),
    usage: { input_tokens: tokens, output_tokens: 12 },
  }), { headers: { 'content-type': 'application/json' } });
}
function docsFromBody(body: any): string[] { return Object.values(body.questions).map((question: any) => question.instructions.candidate); }
function docsFor(init: RequestInit): string[] { return docsFromBody(JSON.parse(init.body as string)); }

afterEach(() => {
  __setRerankTransportForTests(null);
  resetGateway();
});

describe('optional TypeSafe reranker', () => {
  test('existing Voyage selection still sends the entire input in one standard native request', async () => {
    configureGateway({ env: { VOYAGE_API_KEY: 'vk-test-not-a-real-key' } });
    const documents = longDocuments(50);
    let calls = 0;
    __setRerankTransportForTests(async (url, init) => {
      calls++;
      expect(url).toBe('https://api.voyageai.com/v1/rerank');
      expect(JSON.parse(String(init.body))).toEqual({ model: 'rerank-3', query: 'q', documents, top_k: 2 });
      return new Response(JSON.stringify({ data: [{ index: 49, relevance_score: 0.9 }, { index: 0, relevance_score: 0.3 }] }));
    });
    expect(await rerank({ model: 'voyage:rerank-3', query: 'q', documents, topN: 2 }))
      .toEqual([{ index: 49, relevanceScore: 0.9 }, { index: 0, relevanceScore: 0.3 }]);
    expect(calls).toBe(1);
  });

  test('registers only reranking; leaves the default unchanged', () => {
    const recipe = getRecipe('typesafe');
    expect(recipe?.auth_env?.required).toEqual(['TYPESAFE_API_KEY']);
    expect(recipe?.touchpoints.reranker?.models).toContain('jev-1.13.0');
    expect(recipe?.touchpoints.embedding).toBeUndefined();
    expect(recipe?.touchpoints.chat).toBeUndefined();
    expect(DEFAULT_RERANKER_MODEL).toBe('voyage:rerank-2.5');
    expect(rerankerReadiness(MODEL, {}).ready).toBe(false);
    expect(rerankerReadiness(MODEL, { TYPESAFE_API_KEY: 'sk-test' }).ready).toBe(true);
  });

  test('uses the existing home env loader and provider environment merge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-typesafe-env-'));
    try {
      writeFileSync(join(dir, '.env'), 'TYPESAFE_API_KEY=sk-test-file\n');
      await withEnv({ TYPESAFE_API_KEY: undefined }, async () => {
        loadGbrainEnvFile(() => dir);
        expect(mergedProviderEnv(null).TYPESAFE_API_KEY).toBe('sk-test-file');
      });
      await withEnv({ TYPESAFE_API_KEY: 'sk-test-shell' }, async () => {
        loadGbrainEnvFile(() => dir);
        expect(mergedProviderEnv(null).TYPESAFE_API_KEY).toBe('sk-test-shell');
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('sends native System One questions and bearer auth; normalizes fractional scores', async () => {
    configure();
    __setRerankTransportForTests(async (url, init) => {
      expect(url).toBe('https://api.typesafe.ai/v1/systemone');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-test-typesafe');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('jev-1.13.0');
      expect(body.state).toEqual({ query: 'Which launch decision was made?' });
      expect(docsFromBody(body)).toEqual(['routine', 'decision', 'background']);
      expect(body.questions.document_1.instructions.task).toContain('`candidate`');
      expect(body.questions.document_1.instructions.candidate).toBe('decision');
      expect(body.questions.document_1.type).toBe('score');
      expect(body.questions.document_1.criteria).toHaveLength(4);
      expect(body.top_n).toBeUndefined();
      return response([0, 2.7, 1.2]);
    });
    expect(await rerank({ query: 'Which launch decision was made?', documents: ['routine', 'decision', 'background'], topN: 2 }))
      .toEqual([{ index: 1, relevanceScore: 0.9 }, { index: 2, relevanceScore: 1.2 / 3 }]);
  });

  test('merges batch-local indices globally and applies topN after all batches', async () => {
    configure();
    const documents = longDocuments(66);
    let calls = 0;
    __setRerankTransportForTests(async (_url, init) => {
      calls++;
      return response(docsFor(init).map(doc => doc.startsWith('candidate 65:') ? 3 : 1));
    });
    const result = await rerank({ query: 'q', documents, topN: 3 });
    expect(calls).toBe(buildTypeSafeRerankBatches('jev-1.13.0', 'q', documents).length);
    expect(result.map(r => r.index)).toEqual([65, 0, 1]);
  });

  test('shares short context across all independent questions in one call', async () => {
    configure();
    let calls = 0;
    __setRerankTransportForTests(async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body as string);
      expect(body.state).toEqual({ query: 'q' });
      expect(docsFromBody(body)).toHaveLength(30);
      expect(Object.keys(body.questions)).toHaveLength(30);
      expect(body.questions.document_29.instructions.candidate).toBe('d');
      return response(docsFor(init).map(() => 1));
    });
    expect(await rerank({ query: 'q', documents: Array.from({ length: 30 }, () => 'd') })).toHaveLength(30);
    expect(calls).toBe(1);
  });

  test('packs fifty short candidates into one internally parallel request without a fixed question cap', () => {
    const documents = Array.from({ length: 50 }, () => 'Useful background evidence. '.repeat(35));
    const batches = buildTypeSafeRerankBatches('jev-1.13.0', 'q', documents);
    expect(batches).toHaveLength(1);
    expect(Object.keys(JSON.parse(batches[0]!.body).questions)).toHaveLength(50);
    expect(docsFromBody(JSON.parse(batches[0]!.body))).toEqual(documents);
  });

  test('digit-dense input is split without silently dropping or truncating evidence', () => {
    const documents = Array.from({ length: 10 }, () => '1234567890'.repeat(1000));
    const batches = buildTypeSafeRerankBatches('jev-1.13.0', 'q', documents);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap(batch => docsFromBody(JSON.parse(batch.body)))).toEqual(documents);
    expect(batches.every(batch => batch.estimatedInputTokens <= 64_000)).toBe(true);
  });

  test('context batching preserves every long or Unicode document without truncation', () => {
    const documents = Array.from({ length: 50 }, (_, i) => `${i}: ${'漢字🧠 abcdef1234 '.repeat(300)}`);
    const batches = buildTypeSafeRerankBatches('jev-1.13.0', 'q', documents);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap(batch => batch.indices)).toEqual(documents.map((_, i) => i));
    expect(batches.flatMap(batch => docsFromBody(JSON.parse(batch.body)))).toEqual(documents);
  });

  test('a free worker starts queued work while the other requests are still pending', async () => {
    const documents = Array.from({ length: 20 }, () => 'd');
    const batches = documents.map((document, index) => ({
      body: JSON.stringify({ state: { documents: [document] }, questions: {} }),
      indices: [index], estimatedInputTokens: 100,
    }));
    let firstWave!: () => void, nextStarted!: () => void;
    const full = new Promise<void>(resolve => { firstWave = resolve; });
    const queued = new Promise<void>(resolve => { nextStarted = resolve; });
    const pending: Array<() => void> = [];
    let calls = 0, releaseAll = false;
    const run = executeTypeSafeRerankBatches(batches, async body => {
      calls++;
      const json = { answers: Object.fromEntries(JSON.parse(body).state.documents.map((_: string, i: number) =>
        [`document_${i}`, { type: 'score', score: 1 }])) };
      if (calls === 16) firstWave();
      if (calls === 17) nextStarted();
      if (releaseAll) return json;
      return new Promise(resolve => pending.push(() => resolve(json)));
    }, new AbortController().signal, () => {});
    try {
      await full;
      expect(calls).toBe(16);
      pending[0]!();
      await queued;
      expect(calls).toBe(17);
    } finally { releaseAll = true; pending.forEach(resolve => resolve()); }
    const result = await run;
    expect(calls).toBe(batches.length);
    expect(result.map(row => row.index)).toEqual(documents.map((_, i) => i));
  });

  test('oversized single pairs fail before any HTTP request', async () => {
    configure();
    let calls = 0;
    __setRerankTransportForTests(async () => { calls++; return response([3]); });
    expect(() => buildTypeSafeRerankBatches('jev-1.13.0', 'word '.repeat(20_000), ['d'])).toThrow(TypeSafeContextError);
    await expect(rerank({ query: 'word '.repeat(20_000), documents: ['d'] })).rejects.toMatchObject({ reason: 'payload_too_large' });
    expect(calls).toBe(0);
  });

  for (const answer of [undefined, { type: 'choice', choice: 'yes' }, { type: 'score', score: '3' },
    { type: 'score', score: -1 }, { type: 'score', score: 3.1 }, { type: 'score', score: Infinity }]) {
    test(`rejects missing or invalid scores (${JSON.stringify(answer)})`, () => {
      expect(() => parseTypeSafeRerankResponse({ answers: { document_0: answer } }, 1)).toThrow();
    });
  }

  test('missing key skips transport rather than changing providers', async () => {
    configure('');
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

  test('malformed JSON does not echo private response contents', async () => {
    configure();
    __setRerankTransportForTests(async () => new Response('private-source-marker'));
    await expect(rerank({ query: 'q', documents: ['d'] })).rejects.toMatchObject({
      reason: 'unknown', message: 'TypeSafe rerank: malformed JSON',
    });
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
    await expect(rerank({ query: 'q', documents: queuedDocuments(), timeoutMs: 15 }))
      .rejects.toMatchObject({ reason: 'timeout' });
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

  test('records actual input usage from every batch, including questions', async () => {
    configure();
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-typesafe-budget-'));
    try {
      const tracker = new BudgetTracker({ label: 'test', maxCostUsd: 1, auditPath: join(dir, 'audit.jsonl') });
      __setRerankTransportForTests(async (_url, init) => response(docsFor(init).map(() => 1), 321));
      await withBudgetTracker(tracker, () => rerank({ query: 'q', documents: longDocuments(66) }));
      expect(tracker.snapshot().cumulativeCostUsd).toBeCloseTo((321 * buildTypeSafeRerankBatches('jev-1.13.0', 'q', longDocuments(66)).length) * 0.042 / 1_000_000, 12);
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
        return calls === 1 ? response([], 100) : response(docsFor(init).map(() => 2), 100);
      });
      await expect(withBudgetTracker(tracker, () => rerank({ query: 'q', documents: queuedDocuments() })))
        .rejects.toMatchObject({ reason: 'unknown' });
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

  test('one failed batch preserves all search results and original scores', async () => {
    configure();
    const results = Array.from({ length: 40 }, (_, i) => ({ slug: `notes/candidate-${i}`, chunk_text: `d${i}`, title: 'Candidate', score: 40 - i })) as SearchResult[];
    const before = structuredClone(results);
    __setRerankTransportForTests(async (_url, init) => docsFor(init).includes('d32')
      ? new Response('{"answers":{}}', { headers: { 'content-type': 'application/json' } })
      : response(docsFor(init).map(() => 3)));
    expect(await applyReranker('q', results, { enabled: true, topNIn: 34, topNOut: null, model: MODEL })).toEqual(before);
  });

  test('keeps the ordinary Voyage wire unchanged when a TypeSafe key also exists', async () => {
    configureGateway({ reranker_model: 'voyage:rerank-2.5', env: { VOYAGE_API_KEY: 'sk-test-voyage', TYPESAFE_API_KEY: 'sk-test-typesafe' } });
    __setRerankTransportForTests(async (url, init) => {
      expect(url).toBe('https://api.voyageai.com/v1/rerank');
      expect(JSON.parse(init.body as string)).toEqual({ model: 'rerank-2.5', query: 'q', documents: ['d'], top_k: 1 });
      return new Response('{"data":[{"index":0,"relevance_score":0.8}]}');
    });
    expect(await rerank({ query: 'q', documents: ['d'], topN: 1 })).toEqual([{ index: 0, relevanceScore: 0.8 }]);
  });
});
