import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, pairedHit1, parsePools, rerankPoolChunks, scoreRanking, type FrozenPool } from '../scripts/typesafe-rerank-ab.ts';
import { estimateRerankTokens, planVoyageRerankBatches } from '../scripts/lib/rerank-batch-plan.ts';
import { createRerankRequestRecorder, type RerankRequestRecord } from '../scripts/lib/rerank-request-telemetry.ts';
import { withEnv } from './helpers/with-env.ts';
import { createRerankQuota } from '../scripts/lib/rerank-quota.ts';
import { rerankConcurrentPool } from '../scripts/lib/rerank-concurrent.ts';

const pool: FrozenPool = { id: 'decision-1', group: 'decision', query: 'What was decided?',
  candidates: [{ id: 'background', text: 'background' }, { id: 'decision', text: 'decision' }], relevant: ['decision'] };

test('scores an improved first result without counting repeated chunks as extra pages', () => {
  expect(scoreRanking(pool, ['background', 'background', 'decision'])).toEqual({ hit1: 0, hit3: 1, mrr: 0.5, recall3: 1 });
  expect(scoreRanking(pool, ['decision', 'background'])).toEqual({ hit1: 1, hit3: 1, mrr: 1, recall3: 1 });
  expect(scoreRanking(pool, ['background'])).toEqual({ hit1: 0, hit3: 0, mrr: 0, recall3: 0 });
});

test('multi-part recall is distinct from finding one relevant answer', () => {
  expect(scoreRanking({ ...pool, relevant: ['decision', 'followup'] }, ['decision', 'background']).recall3).toBe(0.5);
});

test('splitting retains all documents and merges local indices by score with stable ties', async () => {
  const seen: string[][] = [];
  let paced = 0;
  const result = await rerankPoolChunks({ query: 'q', documents: ['a', 'b', 'c', 'd', 'e'] }, 2,
    async () => { paced++; }, async input => {
      seen.push(input.documents);
      return input.documents.map((text, index) => ({ index, relevanceScore: text === 'e' ? 0.9 : 0.5 }));
    });
  expect(seen).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  expect(paced).toBe(3);
  expect(result.ranked.map(row => row.index)).toEqual([4, 0, 1, 2, 3]);
  expect(result.wallMs).toBeGreaterThanOrEqual(result.activeMs);
});

test('one incomplete baseline chunk rejects the entire comparison and stops queued requests', async () => {
  let calls = 0;
  await expect(rerankPoolChunks({ query: 'q', documents: ['a', 'b', 'c', 'd', 'e'] }, 2,
    async () => {}, async () => {
      calls++;
      return [{ index: 0, relevanceScore: 0.9 }, { index: 0, relevanceScore: 0.5 }];
    })).rejects.toThrow('Incomplete reranking response');
  expect(calls).toBe(1);
});

test('Voyage planning counts the repeated query once for every document and fills token budgets', () => {
  const count = (text: string) => text.length;
  expect(planVoyageRerankBatches('qq', ['aaaa', 'bbbb', 'cccc', 'd'], 12, 1000, count)).toEqual([
    { offset: 0, count: 2, inputTokens: 12 }, { offset: 2, count: 2, inputTokens: 9 },
  ]);
  expect(planVoyageRerankBatches('qq', ['aaaa', 'bbbb', 'cccc', 'd'], 100, 1000, count)).toEqual([
    { offset: 0, count: 4, inputTokens: 21 },
  ]);
});

test('Voyage validates individual pairs and document count before any chunk is sent', () => {
  expect(() => planVoyageRerankBatches('q', ['x'.repeat(32_000)], 600_000, 1000, text => text.length)).toThrow('context budget');
  expect(() => planVoyageRerankBatches('q', ['long'], 4, 1000, text => text.length)).toThrow('request token budget');
  expect(() => planVoyageRerankBatches('q', ['d'], -1)).toThrow('Invalid');
  expect(planVoyageRerankBatches('q', Array.from({ length: 1001 }, () => 'd'), 600_000, 1000, text => text.length).map(batch => batch.count)).toEqual([1000, 1]);
});

test('Voyage margin is explicit and can change batching without replacing actual usage', () => {
  const documents = Array.from({ length: 5 }, () => 'Background evidence. '.repeat(500));
  const full = estimateRerankTokens('q') + estimateRerankTokens(documents[0]!);
  const budget = full * 4;
  expect(planVoyageRerankBatches('q', documents, budget).map(batch => batch.count)).toEqual([4, 1]);
  expect(planVoyageRerankBatches('q', documents, budget, 1000, text => estimateRerankTokens(text, 1.5)).map(batch => batch.count)).toEqual([5]);
  expect(estimateRerankTokens('987654321', 1)).toBeGreaterThanOrEqual(9);
  expect(() => estimateRerankTokens('q', 0.5)).toThrow('margin');
});

test('variable token-driven chunks preserve every candidate and reject gaps before transport', async () => {
  const documents = ['aaaa', 'b', 'cc', 'ddd'];
  const plan = planVoyageRerankBatches('q', documents, 6, 1000, text => text.length);
  const seen: string[][] = [];
  const call = async (input: { documents: string[] }) => {
    seen.push(input.documents);
    return input.documents.map((_, index) => ({ index, relevanceScore: 0.5 }));
  };
  expect((await rerankPoolChunks({ query: 'q', documents }, plan, async () => {}, call)).ranked.map(result => result.index)).toEqual([0, 1, 2, 3]);
  expect(seen).toEqual([['aaaa'], ['b', 'cc'], ['ddd']]);
  seen.length = 0;
  await expect(rerankPoolChunks({ query: 'q', documents }, [{ offset: 1, count: 4, inputTokens: 0 }], async () => {}, call)).rejects.toThrow('coverage');
  expect(seen).toHaveLength(0);
});

test('candidate coverage can be missing without fabricating a relevant result', () => {
  const parsed = parsePools(JSON.stringify({ ...pool, candidates: [] }) + '\n');
  expect(scoreRanking(parsed[0]!, [])).toEqual({ hit1: 0, hit3: 0, mrr: 0, recall3: 0 });
});

test('rejects duplicate IDs, missing labels, and invalid candidate text', () => {
  expect(() => parsePools(`${JSON.stringify(pool)}\n${JSON.stringify(pool)}`)).toThrow();
  expect(() => parsePools(JSON.stringify({ ...pool, relevant: [] }))).toThrow();
  expect(() => parsePools(JSON.stringify({ ...pool, candidates: [{ id: 'a', text: 123 }] }))).toThrow();
  expect(() => parsePools('')).toThrow();
  expect(() => parsePools(JSON.stringify({ ...pool, group: 1 }))).toThrow();
  expect(() => parsePools('null')).toThrow();
  expect(() => parsePools('private-source-marker')).toThrow('Invalid frozen pool JSON; source content omitted');
});

test('dry runs never manufacture repeated quality cases or a provider comparison', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-ab-protocol-'));
  try {
    const input = join(dir, 'pools.jsonl'), out = join(dir, 'receipt.json');
    writeFileSync(input, JSON.stringify(pool) + '\n');
    await main(['--pools', input, '--out', out, '--dry-run', '--candidate-only', '--repeats', '3']);
    const receipt = JSON.parse(readFileSync(out, 'utf8'));
    expect(receipt.status).toBe('dry_run');
    expect(receipt.rows).toHaveLength(1);
    expect(receipt.summary.off.n).toBe(1);
    expect(receipt.summary.off.provider_calls).toBe(0);
    expect(receipt.requests).toEqual([]);
    expect(readFileSync(receipt.request_audit_path, 'utf8')).toBe('');
    expect(receipt.paired_hit_at_1).toBeNull();
  expect(receipt.summary['typesafe:jev-1.13.0']).toBeUndefined();
    expect(receipt.token_planning.plans[0].providers['typesafe:jev-1.13.0'].map((batch: { count: number }) => batch.count)).toEqual([2]);
    await expect(main(['--pools', input, '--out', out, '--dry-run', '--baseline', 'typesafe:jev-1.13.0']))
      .rejects.toThrow('Usage:');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('individual HTTP telemetry preserves concurrent start order, actual usage and overlapping timings', async () => {
  const completed: RerankRequestRecord[] = [];
  const recorder = createRerankRequestRecorder(() => 0.042, record => completed.push(record));
  let finishFirst!: (response: Response) => void;
  const context = { profile_id: 'long-control', sample: 1, model: 'typesafe:jev-1.13.0', batch: 1,
    document_offset: 0, document_count: 14, document_chars: 84_000, estimated_input_tokens: 30_000, quota_wait_ms: 0 };
  const first = recorder.run(context, 'private-evidence-one', () => new Promise(resolve => { finishFirst = resolve; }));
  const second = recorder.run({ ...context, batch: 2, document_offset: 14 }, 'private-evidence-two', async () =>
    Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 700 }, answers: { document_0: { score: 2 } } }));
  const response = await second;
  expect(await response.json()).toHaveProperty('usage.input_tokens', 700);
  finishFirst(Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 100 }, answers: {} }));
  await first;
  expect(completed.map(record => record.request_id)).toEqual([2, 1]);
  expect(recorder.records.map(record => record.request_id)).toEqual([1, 2]);
  expect(recorder.records.map(record => record.in_flight_on_start)).toEqual([1, 2]);
  expect(recorder.records[1]!.start_offset_ms).toBeLessThan(recorder.records[0]!.duration_ms);
  expect(recorder.records.map(record => record.input_tokens)).toEqual([100, 700]);
  expect(recorder.records.reduce((sum, record) => sum + record.cost_usd!, 0)).toBeCloseTo(800 * 0.042 / 1_000_000, 10);
  expect(JSON.stringify(completed)).not.toContain('private-evidence');
  expect(recorder.records.every(record => record.duration_ms >= record.headers_ms!)).toBe(true);
});

test('HTTP audit never substitutes estimated tokens for missing usage or persists raw errors', async () => {
  const recorder = createRerankRequestRecorder(() => 0.05, () => {});
  const context = { profile_id: 'short-control', sample: 1, model: 'voyage:rerank-3', batch: 1,
    document_offset: 0, document_count: 1, document_chars: 1000, estimated_input_tokens: 500,
    quota_wait_ms: 0,
    unrelated_private_field: 'private-extra-marker' };
  await recorder.run(context, 'private-source-marker', async () => Response.json({
    error: 'private-response-marker', usage: { total_tokens: -1 },
  }, { status: 429 }));
  await recorder.run({ ...context, batch: 2 }, 'private-source-marker', async () => new Response('private-response-marker'));
  await expect(recorder.run({ ...context, batch: 3 }, 'private-source-marker', async () => {
    throw new Error('private-error-marker');
  })).rejects.toThrow('private-error-marker');
  expect(recorder.records.map(record => record.failure)).toEqual(['http_error', 'invalid_json', 'transport_error']);
  expect(recorder.records.every(record => record.input_tokens === null && record.cost_usd === null)).toBe(true);
  expect(recorder.records.map(record => record.http_status)).toEqual([429, 200, null]);
  expect(JSON.stringify(recorder.records)).not.toContain('private-');
});

test('rolling quota packs remaining capacity, settles actual usage and sleeps only at the window boundary', async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const quota = createRerankQuota(3, 10_000, () => clock, async ms => { sleeps.push(ms); clock += ms; });
  const pairs = Array.from({ length: 20 }, () => 2010);
  const first = await quota.acquire(0, pairs, 10_500, 1000);
  expect(first.plan).toEqual({ offset: 0, count: 4, inputTokens: 8040 });
  first.settle(4005);
  const second = await quota.acquire(4, pairs, 10_500, 1000);
  expect(second.plan.count).toBe(2);
  second.settle(2002);
  const third = await quota.acquire(6, pairs, 10_500, 1000);
  expect(third.plan.count).toBe(1);
  third.settle(1001);
  expect(sleeps).toEqual([]);
  const fourth = await quota.acquire(7, pairs, 10_500, 1000);
  expect(fourth.plan.count).toBe(4);
  expect(fourth.waitMs).toBe(61_000);
  expect(sleeps).toEqual([60_000, 1000]);
});

test('missing quota usage retains reservation; unfit evidence rejects without waiting', async () => {
  let clock = 0, waits = 0;
  const quota = createRerankQuota(3, 10_000, () => clock, async ms => { waits++; clock += ms; });
  const pairs = [6000, 6000];
  const first = await quota.acquire(0, pairs, 10_000, 1000);
  first.settle(null);
  expect((await quota.acquire(1, pairs, 10_000, 1000)).waitMs).toBe(61_000);
  expect(waits).toBe(2);
  await expect(quota.acquire(0, [10_001], 20_000, 1000)).rejects.toThrow('quota budget');
  expect(waits).toBe(2);
  expect(() => createRerankQuota(0, 1000)).toThrow('Invalid');
});

test('in-flight reservations share token capacity and settlement wakes waiting dispatch immediately', async () => {
  const quota = createRerankQuota(3, 100, undefined, undefined, 2000);
  const first = await quota.acquire(0, [60, 60], 100, 1);
  let admitted = false;
  const second = quota.acquire(1, [60, 60], 100, 1).then(value => { admitted = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(admitted).toBe(false);
  first.settle(20);
  const reservation = await second;
  expect(reservation.waitMs).toBeLessThan(1000);
  expect(reservation.plan.offset).toBe(1);
  reservation.settle(20);
});

test('packing avoids wasting a scarce RPM slot on a tiny non-final concurrent batch', async () => {
  const quota = createRerankQuota(3, 10_000, undefined, undefined, 2000);
  const pairs = Array.from({ length: 50 }, () => 320);
  const first = await quota.acquire(0, pairs, 9040, 1000);
  expect(first.plan.count).toBe(28);
  let admitted = false;
  const waiting = quota.acquire(28, pairs, 9040, 1000, undefined, 4520).then(value => { admitted = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(admitted).toBe(false); // Spare tokens fit 3 docs; wait to fit 16 instead.
  first.settle(4872);
  const second = await waiting;
  expect(second.plan.count).toBe(16);
  second.settle(2784);
  const last = await quota.acquire(44, pairs, 9040, 1000, undefined, 4520);
  expect(last.plan.count).toBe(6);
  expect(last.waitMs).toBeLessThan(1000);
});

test('concurrent dispatch merges out-of-order results and counts overlapping active intervals once', async () => {
  const quota = createRerankQuota(3, 1000);
  let inFlight = 0, peak = 0, summedMs = 0;
  const seen: number[] = [];
  const result = await rerankConcurrentPool({ query: 'q', documents: ['a', 'b', 'gold'] }, 2,
    async (offset, signal) => {
      const reservation = await quota.acquire(offset, [10, 10, 10], 10, 1, signal);
      return { ...reservation, settle() { reservation.settle(10); } };
    }, async (input, plan) => {
      const start = performance.now();
      seen.push(plan.offset);
      peak = Math.max(peak, ++inFlight);
      await new Promise(resolve => setTimeout(resolve, plan.offset === 0 ? 70 : 20));
      inFlight--;
      summedMs += performance.now() - start;
      return input.documents.map((doc, index) => ({ index, relevanceScore: doc === 'gold' ? 1 : 0.5 }));
    });
  expect(seen).toEqual([0, 1, 2]);
  expect(peak).toBe(2);
  expect(result.ranked.map(row => row.index)).toEqual([2, 0, 1]);
  expect(result.activeMs).toBeGreaterThanOrEqual(60);
  expect(result.activeMs).toBeLessThan(summedMs - 20);
  expect(result.wallMs).toBeGreaterThanOrEqual(result.activeMs);
});

test('profile isolation expires all prior reservations before a fresh measured operation', async () => {
  let clock = 0;
  const quota = createRerankQuota(3, 100, () => clock, async ms => { clock += ms; });
  await quota.acquire(0, [40], 100, 1);
  clock = 1000;
  await quota.acquire(0, [40], 100, 1);
  await quota.idle();
  expect(clock).toBe(62_000);
  expect((await quota.acquire(0, [100], 100, 1)).waitMs).toBe(0);
});

test('concurrent failure cancels quota waits and drains started calls without launching queued evidence', async () => {
  const quota = createRerankQuota(3, 100);
  let calls = 0, settled = 0;
  await expect(rerankConcurrentPool({ query: 'q', documents: ['a', 'b', 'c'] }, 3,
    async (offset, signal) => {
      const reservation = await quota.acquire(offset, [60, 60, 60], 100, 1, signal);
      return { ...reservation, settle() { settled++; reservation.settle(null); } };
    }, async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); throw new Error('invalid response'); }))
    .rejects.toThrow('invalid response');
  expect(calls).toBe(1);
  expect(settled).toBe(1);

  let drained = false;
  calls = 0;
  await expect(rerankConcurrentPool({ query: 'q', documents: ['a', 'b', 'c'] }, 2,
    async offset => ({ plan: { offset, count: 1, inputTokens: 1 }, waitMs: 0, settle() {} }),
    async (_input, plan) => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, plan.offset === 0 ? 5 : 30));
      if (plan.offset === 0) return [];
      drained = true;
      return [{ index: 0, relevanceScore: 1 }];
    })).rejects.toThrow('Incomplete reranking response');
  expect(calls).toBe(2);
  expect(drained).toBe(true);
});

test('dynamic quota batches retain global coverage and exclude boundary waits from active time', async () => {
  const batches = (async function* () {
    yield { offset: 0, count: 2, inputTokens: 20 };
    await new Promise(resolve => setTimeout(resolve, 25));
    yield { offset: 2, count: 1, inputTokens: 10 };
  })();
  const result = await rerankPoolChunks({ query: 'q', documents: ['a', 'b', 'gold'] }, batches, async () => {},
    async input => input.documents.map((doc, index) => ({ index, relevanceScore: doc === 'gold' ? 1 : 0 })));
  expect(result.ranked.map(result => result.index)).toEqual([2, 0, 1]);
  expect(result.quotaWaitMs).toBeGreaterThanOrEqual(20);
  expect(result.wallMs).toBeGreaterThanOrEqual(result.activeMs + 20);
});

test('dry-run quota settings validate all pairs before spending and expose independent limits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-quota-preflight-'));
  try {
    const input = join(dir, 'pools.jsonl'), out = join(dir, 'receipt.json');
    writeFileSync(input, JSON.stringify(pool) + '\n');
    await main(['--pools', input, '--out', out, '--dry-run', '--baseline', 'voyage:rerank-3', '--baseline-rpm', '3', '--baseline-tpm', '10000']);
    const receipt = JSON.parse(readFileSync(out, 'utf8'));
    expect(receipt.baseline_quota).toMatchObject({ rpm: 3, tpm: 10_000, window_ms: 61_000 });
    expect(receipt.requests).toEqual([]);
    await expect(main(['--pools', input, '--out', out, '--dry-run', '--baseline-rpm', '3'])).rejects.toThrow('Usage');
    await expect(main(['--pools', input, '--out', out, '--dry-run', '--baseline-rpm', '3', '--baseline-tpm', '1'])).rejects.toThrow('request token budget');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('paired harness associates every HTTP request with its batch and reconciles provider totals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-request-audit-'));
  try {
    await withEnv({ GBRAIN_HOME: dir, TYPESAFE_API_KEY: 'sk-test-typesafe', VOYAGE_API_KEY: 'sk-test-voyage' }, async () => {
      const input = join(dir, 'pools.jsonl'), out = join(dir, 'receipt.json');
      writeFileSync(input, JSON.stringify(pool) + '\n');
      await main(['--pools', input, '--out', out, '--baseline', 'voyage:rerank-3', '--baseline-batch-size', '1',
        '--baseline-concurrency', '3', '--baseline-rpm', '3', '--baseline-tpm', '10000'], async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        if (body.state) return Response.json({ model: 'jev-1.13.0', usage: { input_tokens: 103 },
          answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'score', score: 2 }])) });
        expect(body.truncation).toBe(false);
        await new Promise(resolve => setTimeout(resolve, body.documents[0] === 'background' ? 15 : 5));
        return Response.json({ model: 'rerank-3', usage: { total_tokens: 37 },
          data: body.documents.map((_doc: string, index: number) => ({ index, relevance_score: 0.5 })) });
      });
      const receipt = JSON.parse(readFileSync(out, 'utf8'));
      const requests = receipt.requests as RerankRequestRecord[];
      expect(receipt.status).toBe('complete');
      expect(receipt.baseline_concurrency).toBe(3);
      expect(requests).toHaveLength(3);
      expect(requests.map(record => record.request_id)).toEqual([1, 2, 3]);
      expect(requests.filter(record => record.model.startsWith('voyage:')).map(record => record.document_offset)).toEqual([0, 1]);
      expect(requests.filter(record => record.model.startsWith('voyage:')).map(record => record.in_flight_on_start)).toEqual([1, 2]);
      expect(requests.filter(record => record.model.startsWith('typesafe:')).map(record => record.document_count)).toEqual([2]);
      expect(requests.every(record => record.result_count === record.document_count)).toBe(true);
      for (const model of ['voyage:rerank-3', 'typesafe:jev-1.13.0']) {
        const selected = requests.filter(record => record.model === model);
        expect(receipt.summary[model].input_tokens).toBe(selected.reduce((sum, record) => sum + record.input_tokens!, 0));
        expect(receipt.summary[model].cost_usd).toBeCloseTo(selected.reduce((sum, record) => sum + record.cost_usd!, 0), 10);
        expect(receipt.rows[0][model].provider_calls).toBe(selected.length);
      }
      const audit = readFileSync(receipt.request_audit_path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(audit).toHaveLength(3);
      expect(audit.map(record => record.request_id)).toEqual([2, 1, 3]);
      expect(JSON.stringify(requests)).not.toContain('sk-test-');
      expect(requests.every(record => record.profile_id === pool.id && [1, 2].includes(record.sample))).toBe(true);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid fixed batch sizes reject before calling a provider; empty evidence sends no calls', async () => {
  let calls = 0;
  const call = async () => { calls++; return []; };
  for (const size of [-1, 0.5, NaN, Infinity]) {
    await expect(rerankPoolChunks({ query: 'q', documents: ['a'] }, size, async () => {}, call)).rejects.toThrow('coverage');
  }
  expect((await rerankPoolChunks({ query: 'q', documents: [] }, 0, async () => {}, call)).ranked).toEqual([]);
  expect(calls).toBe(0);
});

test('dry run records different provider plans and rejects a late oversized pair before spending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-token-preflight-'));
  try {
    const input = join(dir, 'pools.jsonl'), out = join(dir, 'receipt.json');
    const candidates = Array.from({ length: 50 }, (_, i) => ({ id: `c-${i}`, text: 'Background evidence. '.repeat(35) }));
    writeFileSync(input, JSON.stringify({ ...pool, candidates, relevant: ['c-49'] }) + '\n');
    await main(['--pools', input, '--out', out, '--dry-run', '--baseline', 'voyage:rerank-3', '--baseline-max-input-tokens', '1000']);
    const receipt = JSON.parse(readFileSync(out, 'utf8'));
    const plans = receipt.token_planning.plans[0].providers;
    expect(plans['typesafe:jev-1.13.0']).toHaveLength(1);
    expect(plans['voyage:rerank-3'].length).toBeGreaterThan(1);
    expect(plans['voyage:rerank-3'].reduce((sum: number, batch: { count: number }) => sum + batch.count, 0)).toBe(50);
    expect(receipt.summary.off.provider_calls).toBe(0);
    writeFileSync(input, JSON.stringify(pool) + '\n' + JSON.stringify({ ...pool, id: 'oversized', candidates: [{ id: 'x', text: 'x' }], query: 'word '.repeat(20_000) }) + '\n');
    await expect(main(['--pools', input, '--out', out, '--dry-run', '--candidate-only'])).rejects.toThrow('context budget');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('paired reporting exposes losses rather than hiding them in the net gain', () => {
  const result = pairedHit1([1, 0, 1, 0], [1, 1, 0, 0], ['a', 'b', 'c', 'd']);
  expect(result.delta).toBe(0);
  expect(result.wins).toBe(1);
  expect(result.losses).toBe(1);
  expect(result.ties).toBe(2);
  expect(result.ci95[0]).toBeLessThan(0);
  expect(result.ci95[1]).toBeGreaterThan(0);
});

test('related paraphrases form one resampling cluster and the receipt is reproducible', () => {
  const result = pairedHit1([0, 0, 1], [1, 1, 1], ['same-source', 'same-source', 'other-source']);
  expect(result.clusters).toBe(2);
  expect(result.delta).toBeCloseTo(2 / 3);
  expect(result).toEqual(pairedHit1([0, 0, 1], [1, 1, 1], ['same-source', 'same-source', 'other-source']));
  expect(() => pairedHit1([1], [], ['a'])).toThrow();
});
