/**
 * System One S1 (rerank) and S3 (evidence gate) wired through bare
 * hybridSearch on PGLite with fixture transports (no provider is called).
 *
 * Protects: all-off output is byte-identical to a brain with no decide keys;
 * S3 prunes below threshold without reordering, never below min_keep, never a
 * protected result, and fails open on provider failure, timeout, budget and
 * model drift; private pages are never sent; receipts carry hashes only; S1
 * reranks through the decide core, stamps meta.rerank.model_resolved, writes
 * receipts in on mode and fails open on mixed resolved models; S1 shadow
 * beside a disabled reranker records rank agreement without changing results.
 * Serial: mutates GBRAIN_HOME and the process-global gateway.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import {
  configureGateway, resetGateway, __setDecideTransportForTests, __setEmbedTransportForTests, __setRerankTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { flushDecideWrites, __resetDecideStoreForTests, insertCalibration } from '../../src/core/ai/decide/store.ts';
import { resetDecideSearchCache } from '../../src/core/search/decide-stage.ts';
import { gradeRetrievalConfidence } from '../../src/core/search/crag.ts';
import { packShape } from '../../src/core/ai/decide/pack.ts';
import type { HybridSearchMeta, SearchResult } from '../../src/core/types.ts';

let engine: PGLiteEngine;
let home: string;
let prevHome: string | undefined;
const DIMS = 1536;
const FAKE_EMB = Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0.01));
const SLUGS = ['notes/one', 'notes/two', 'notes/three', 'notes/four', 'notes/five'];
const TEXT: Record<string, string> = {
  'notes/one': 'alpha keyword decision one', 'notes/two': 'alpha keyword chatter two', 'notes/three': 'alpha keyword chatter three',
  'notes/four': 'alpha keyword chatter four', 'notes/five': 'alpha keyword chatter five',
};

type Answer = (candidate: string, kind: string) => number;
let decideBodies: any[] = [];
function decideTransport(answer: Answer, model = () => 'jev-1.13.0') {
  __setDecideTransportForTests(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    decideBodies.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => {
      const c = typeof q.instructions === 'string' ? '' : q.instructions.candidate ?? '';
      return [id, q.type === 'score' ? { type: 'score', score: answer(c, 'score'), confidence: 1 } : { type: 'noul', noul: answer(c, 'noul') }];
    }));
    return new Response(JSON.stringify({ model: model(), answers, usage: { input_tokens: 100, output_tokens: 10 } }));
  });
}

async function setConfig(kv: Record<string, string>) {
  for (const [k, v] of Object.entries(kv)) await engine.setConfig(k, v);
  resetDecideSearchCache();
}

async function clearDecideConfig() {
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'decide.%' OR key LIKE 'search.reranker.%'`);
  await engine.executeRaw('DELETE FROM decision_receipts');
  await engine.executeRaw('DELETE FROM decide_spend');
  await engine.executeRaw('DELETE FROM decide_calibrations');
  resetDecideSearchCache();
  __resetDecideStoreForTests();
}

async function search(query = 'alpha keyword', extra: Record<string, unknown> = {}): Promise<{ results: SearchResult[]; meta: HybridSearchMeta | null }> {
  let meta: HybridSearchMeta | null = null;
  const results = await hybridSearch(engine, query, { limit: 10, expansion: false, onMeta: (m) => { meta = m; }, ...extra });
  return { results, meta };
}

async function receipts(): Promise<Array<Record<string, unknown>>> {
  await new Promise((r) => setTimeout(r, 30));
  await flushDecideWrites();
  return engine.executeRaw('SELECT * FROM decision_receipts ORDER BY slot, rank');
}

const S3_ON = {
  'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.evidence.mode': 'on', 'decide.slots.evidence.threshold': '0.5',
  'decide.slots.evidence.force_on': 'true', 'decide.slots.evidence.min_keep': '1',
  'decide.egress.typesafe.query': 'allow', 'decide.egress.typesafe.candidates': 'allow',
};

beforeAll(async () => {
  prevHome = process.env.GBRAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'gbrain-decide-slots-'));
  process.env.GBRAIN_HOME = home;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const slug of SLUGS) {
    await engine.putPage(slug, { type: 'note', title: slug.split('/')[1]!, compiled_truth: TEXT[slug]! });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: TEXT[slug]!, chunk_source: 'compiled_truth' }]);
  }
  await engine.putPage('notes/secret', { type: 'note', title: 'secret', compiled_truth: 'alpha keyword private secret', frontmatter: { visibility: 'private' } });
  await installFixtureChunks(engine, 'notes/secret', [{ chunk_index: 0, chunk_text: 'alpha keyword private secret', chunk_source: 'compiled_truth' }]);
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test', TYPESAFE_API_KEY: 'sk-test-typesafe' },
  });
  __setEmbedTransportForTests(async (args: any) => ({ embeddings: args.values.map(() => FAKE_EMB) }) as any);
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  __setDecideTransportForTests(null);
  __setRerankTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearDecideConfig();
  decideBodies = [];
  __setDecideTransportForTests(null);
  __setRerankTransportForTests(null);
});

describe('all slots off', () => {
  test('output and meta are byte-identical to a brain with no decide keys, and nothing is sent', async () => {
    const baseline = await search();
    await setConfig({ 'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.evidence.mode': 'off', 'decide.slots.rerank.mode': 'off', 'decide.egress.typesafe.query': 'allow' });
    decideTransport(() => 0);
    const after = await search();
    expect(JSON.stringify(after.results)).toBe(JSON.stringify(baseline.results));
    expect(JSON.stringify(after.meta)).toBe(JSON.stringify(baseline.meta));
    expect(decideBodies).toHaveLength(0);
    expect(await receipts()).toHaveLength(0);
  });
});

describe('S3 evidence gate', () => {
  test('prunes below threshold, never reorders, stamps decide_evidence and writes hash-only receipts', async () => {
    const baseline = await search();
    await setConfig(S3_ON);
    decideTransport((c) => (c.includes('decision') ? 0.9 : 0.1));
    const { results, meta } = await search();
    // notes/secret is private: never sent, so unjudged and kept (fail open).
    expect(results.map((r) => r.slug)).toEqual(baseline.results.map((r) => r.slug).filter((s) => s === 'notes/one' || s === 'notes/secret'));
    expect(results[0]!.decide_evidence).toEqual({ p: 0.9, clears: true });
    expect(meta?.decide?.evidence).toMatchObject({ mode: 'on', effective: 'on', model_resolved: 'jev-1.13.0', threshold: 0.5 });
    expect(gradeRetrievalConfidence(results)).toMatchObject({ level: 'strong', reason: 'decide_evidence' });
    expect(gradeRetrievalConfidence(results, { ignoreDecideEvidence: true }).reason).not.toBe('decide_evidence');
    const rows = await receipts();
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map((r) => r.outcome).sort()).toContain('pruned');
    const dump = JSON.stringify(rows);
    for (const text of ['alpha keyword', 'decision one', 'notes/one']) expect(dump).not.toContain(text);
    expect(rows.every((r) => typeof r.subject_ref === 'string' && (r.subject_ref as string).length === 32)).toBe(true);
  });

  test('min_keep restores the best-ranked pruned candidates', async () => {
    const baseline = await search();
    await setConfig({ ...S3_ON, 'decide.slots.evidence.min_keep': '3' });
    decideTransport(() => 0.01);
    const { results } = await search();
    // The unjudged private page survives and counts toward min_keep; the two best-ranked judged pages return.
    const judged = baseline.results.map((r) => r.slug).filter((s) => s !== 'notes/secret').slice(0, 2);
    expect(results.map((r) => r.slug)).toEqual(baseline.results.map((r) => r.slug).filter((s) => s === 'notes/secret' || judged.includes(s)));
  });

  test('a protected identity hit is never pruned', async () => {
    await setConfig(S3_ON);
    decideTransport(() => 0);
    const { results } = await search('notes/three');
    expect(results.some((r) => r.slug === 'notes/three')).toBe(true);
  });

  test('private pages are never sent and are kept (unjudged)', async () => {
    const baseline = await search();
    await setConfig(S3_ON);
    decideTransport(() => 0.9);
    const { results } = await search();
    const sent = JSON.stringify(decideBodies);
    expect(sent).not.toContain('private secret');
    expect(results.map((r) => r.slug)).toEqual(baseline.results.map((r) => r.slug));
  });

  for (const [name, setup, reason] of [
    ['provider 5xx', () => __setDecideTransportForTests(async () => new Response('boom', { status: 503 })), 'provider_error'],
    ['malformed response', () => __setDecideTransportForTests(async () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers: {} }))), 'malformed_response'],
    ['timeout', () => __setDecideTransportForTests(async (_u, init) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))), 'timeout'],
  ] as const) {
    test(`fails open on ${name}`, async () => {
      const baseline = await search();
      await setConfig({ ...S3_ON, 'decide.timeout_ms': '100' });
      setup();
      const { results, meta } = await search();
      expect(results.map((r) => r.slug)).toEqual(baseline.results.map((r) => r.slug));
      expect(meta?.decide?.evidence).toMatchObject({ effective: 'off', skipped: reason });
      const rows = await receipts();
      expect(rows.every((r) => r.outcome === 'error' && r.error_reason === reason)).toBe(true);
    });
  }

  test('an exhausted daily budget fails open before any request', async () => {
    const baseline = await search();
    await setConfig({ ...S3_ON, 'decide.budget.daily_usd': '0' });
    decideTransport(() => 0);
    const { results, meta } = await search();
    expect(decideBodies).toHaveLength(0);
    expect(results.map((r) => r.slug)).toEqual(baseline.results.map((r) => r.slug));
    expect(meta?.decide?.evidence?.skipped).toBe('budget_exhausted');
  });

  test('model drift from the calibration runs with off behavior and records the reason', async () => {
    const baseline = await search();
    const { threshold: _t, ...noOverride } = { ...S3_ON, threshold: undefined };
    delete (noOverride as Record<string, string>)['decide.slots.evidence.threshold'];
    await insertCalibration(engine, {
      slot: 'evidence', call_site: 'search', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.5, min_keep: 1,
      metric: 'f1', metric_value: 0.9, ece: 0.02, retest_sd: 0, repack_sd: 0, n: 100, dataset_hash: 'd', split_hash: 's',
      calibrate_ids_hash: 'c', calibrate_only: true, pack_shape: packShape('evidence'), notes: null,
    });
    await setConfig(noOverride as Record<string, string>);
    decideTransport(() => 0.01, () => 'jev-1.14.0');
    const { results, meta } = await search();
    expect(results.map((r) => r.slug)).toEqual(baseline.results.map((r) => r.slug));
    expect(meta?.decide?.evidence).toMatchObject({ skipped: 'model_drift', effective: 'off' });
    const rows = await receipts();
    expect(rows.filter((r) => r.error_reason !== 'egress_private_denied').every((r) => r.error_reason === 'model_drift')).toBe(true);
    expect(rows.filter((r) => r.error_reason === 'egress_private_denied')).toHaveLength(1);
  });

  test('on without calibration is inactive: no request, skipped receipts, meta names the cause', async () => {
    await setConfig({ ...S3_ON, 'decide.slots.evidence.threshold': '' });
    await engine.executeRaw(`DELETE FROM config WHERE key = 'decide.slots.evidence.threshold'`);
    decideTransport(() => 0);
    const { meta } = await search();
    expect(decideBodies).toHaveLength(0);
    expect(meta?.decide?.evidence).toMatchObject({ mode: 'on', effective: 'off', skipped: 'no_calibration' });
    expect((await receipts()).every((r) => r.outcome === 'skipped' && r.error_reason === 'no_calibration')).toBe(true);
  });

  test('shadow (awaited via shadow_wait) records would-be outcomes and changes nothing', async () => {
    const baseline = await search();
    await setConfig({ ...S3_ON, 'decide.slots.evidence.mode': 'shadow', 'decide.slots.evidence.shadow_sample': '1', 'decide.slots.evidence.shadow_wait': 'on' });
    decideTransport(() => 0.01);
    const { results, meta } = await search();
    expect(results.map((r) => r.slug)).toEqual(baseline.results.map((r) => r.slug));
    expect(results.every((r) => r.decide_evidence === undefined)).toBe(true);
    expect(meta?.decide?.evidence?.effective).toBe('shadow');
    const rows = await receipts();
    expect(rows.every((r) => r.mode === 'shadow')).toBe(true);
    expect(rows.some((r) => r.outcome === 'pruned')).toBe(true);
  });
});

describe('S1 rerank', () => {
  const JEV = { 'search.reranker.enabled': 'true', 'search.reranker.model': 'typesafe:jev-1.13.0' };
  function rerankTransport(score: (c: string) => number, model = () => 'jev-1.13.0') {
    __setRerankTransportForTests(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        model: model(),
        answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => [id, { type: 'score', score: score(q.instructions.candidate) }])),
        usage: { input_tokens: 50 },
      }));
    });
  }

  test('on: reranks through the decide core, stamps meta.rerank and writes kept receipts', async () => {
    await setConfig({ ...JEV, 'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.rerank.mode': 'on' });
    rerankTransport((c) => (c.includes('five') ? 3 : 1));
    const { results, meta } = await search();
    expect(results[0]!.slug).toBe('notes/five');
    expect(results[0]!.rerank_score_kind).toBe('rubric');
    expect(meta?.rerank).toEqual({ model_resolved: 'jev-1.13.0' });
    expect(meta?.decide?.rerank).toMatchObject({ mode: 'on', effective: 'on', model_resolved: 'jev-1.13.0' });
    const rows = await receipts();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.slot === 'rerank' && r.outcome === 'kept')).toBe(true);
  });

  test('retrieval time before rerank does not spend the decide query budget (expansion regression)', async () => {
    await setConfig({ ...JEV, 'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.rerank.mode': 'on', 'decide.query_budget_ms': '200' });
    __setRerankTransportForTests(async (_url, init) => {
      await new Promise((r) => setTimeout(r, 60));
      init.signal?.throwIfAborted();
      const body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        model: 'jev-1.13.0',
        answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => [id, { type: 'score', score: q.instructions.candidate.includes('five') ? 3 : 1 }])),
        usage: { input_tokens: 50 },
      }));
    });
    __setEmbedTransportForTests(async (args: any) => {
      await new Promise((r) => setTimeout(r, 400));
      return { embeddings: args.values.map(() => FAKE_EMB) } as any;
    });
    try {
      const { results, meta } = await search();
      expect(meta?.decide?.rerank).toMatchObject({ mode: 'on', effective: 'on', model_resolved: 'jev-1.13.0' });
      expect(results[0]!.slug).toBe('notes/five');
    } finally {
      __setEmbedTransportForTests(async (args: any) => ({ embeddings: args.values.map(() => FAKE_EMB) }) as any);
    }
  });

  test('off writes no receipts even with the Jev reranker selected (the #5178 path)', async () => {
    await setConfig(JEV);
    rerankTransport(() => 2);
    const { meta } = await search();
    expect(meta?.rerank).toEqual({ model_resolved: 'jev-1.13.0' });
    expect(meta?.decide).toBeUndefined();
    expect(await receipts()).toHaveLength(0);
  });

  test('a failed Jev rerank fails open to fused order with an error receipt (mixed models: test/ai/typesafe-reranker.test.ts)', async () => {
    const baseline = await search();
    await setConfig({ ...JEV, 'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.rerank.mode': 'on' });
    __setRerankTransportForTests(async () => new Response('private-marker', { status: 503 }));
    const { results, meta } = await search();
    expect(results.map((r) => r.slug)).toEqual(baseline.results.map((r) => r.slug));
    expect(meta?.decide?.rerank).toMatchObject({ effective: 'off', skipped: 'provider_error' });
    const rows = await receipts();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.outcome === 'error')).toBe(true);
  });

  test('shadow beside a disabled reranker scores in parallel, records agreement and changes nothing', async () => {
    const baseline = await search();
    await setConfig({
      'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.rerank.mode': 'shadow', 'decide.slots.rerank.shadow_wait': 'on',
      'decide.egress.typesafe.query': 'allow', 'decide.egress.typesafe.candidates': 'allow',
    });
    decideTransport((c) => (c.includes('five') ? 3 : 0));
    const { results, meta } = await search();
    expect(results.map((r) => r.slug)).toEqual(baseline.results.map((r) => r.slug));
    expect(meta?.decide?.rerank).toMatchObject({ mode: 'shadow', effective: 'shadow' });
    expect(typeof meta?.decide?.rerank?.agreement?.kendall_tau).toBe('number');
    const rows = await receipts();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.mode === 'shadow' && String(r.run_meta).startsWith('rank_agreement'))).toBe(true);
  });
});
