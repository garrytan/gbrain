/**
 * `gbrain eval longmemeval --decide ...` (System One arms) on the real
 * hybridSearch path with fixture embed and decide transports (no provider is
 * called).
 *
 * Protects: the all-off run carries no decide field and keeps its
 * retrieval_config_hash; an arm configures the benchmark brain (provider,
 * consent, threshold, force_on) so S3 acts, stamps a per-row `decide` receipt
 * (mode, effective, threshold, outcomes, latency, model, judged, decide
 * tokens and cost from the brain's decide_spend) and S2's late flag, and the
 * summary's run_config gains `decide` + `decide_summary` with a different
 * hash; `--decide answerable=on` makes the harness reader abstain on the S4
 * verdict; `--decide-dataset` restricts to the eval half and refuses a
 * mismatched split (split_mismatch); a --decide arm refuses trajectory
 * routing (it reads question_type labels); `--capture-pool` rows report
 * pool_recall at fused depths 30/50/100/300; `--eval-pool-depth` folds into
 * the hash and pins top_n_in.
 * Serial: mutates the process-global gateway, transports and GBRAIN_DECIDE_SLOTS.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests, __setEmbedTransportForTests, __setRerankTransportForTests } from '../src/core/ai/gateway.ts';
import { enableDecideEvalOverride } from '../src/core/ai/decide/config.ts';
import { splitHash, stableSplit } from '../src/core/ai/decide/dataset.ts';
import { __resetDecideStoreForTests } from '../src/core/ai/decide/store.ts';
import { resetDecideSearchCache } from '../src/core/search/decide-stage.ts';
import { setEvalPoolDepth } from '../src/core/search/eval-pool-depth.ts';
import type { ThinkLLMClient } from '../src/core/think/index.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'longmemeval-mini.jsonl');
const DIMS = 1536;
const tmp = mkdtempSync(join(tmpdir(), 'lme-decide-'));
const prevEnv = process.env.GBRAIN_DECIDE_SLOTS;
const QIDS = readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).question_id as string);
const embedTransport = (async (p: { values: string[] }) => ({
  embeddings: p.values.map((v) => Array.from({ length: DIMS }, (_, j) => (j === v.length % DIMS ? 1 : 0.01))), values: p.values, warnings: [], usage: { tokens: p.values.length },
})) as unknown as Parameters<typeof __setEmbedTransportForTests>[0];

let decideBodies: any[] = [];
let answerableP = 0.9;
function decideTransport() {
  __setDecideTransportForTests(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    decideBodies.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => {
      if (q.type === 'score') return [id, { type: 'score', score: 2, confidence: 1 }];
      if (q.type === 'choice') return [id, { type: 'choice', choice: 'general', probabilities: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === 'general' ? 0.9 : 0.02])), confidence: 0.9 }];
      return [id, { type: 'noul', noul: id.startsWith('answerable:') ? answerableP : 0.9 }];
    }));
    if (Object.keys(body.questions).some((id) => id.startsWith('intent:'))) await new Promise((r) => setTimeout(r, 300));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 120, output_tokens: 0 } }));
  });
}

const stubReader: ThinkLLMClient = {
  create: async () => ({ content: [{ type: 'text', text: 'a reader answer' }], stop_reason: 'end_turn', model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } }) as never,
} as ThinkLLMClient;
let readerCalls = 0;
const countingReader: ThinkLLMClient = { create: async (...a: unknown[]) => { readerCalls++; return (stubReader.create as (...x: unknown[]) => unknown)(...a); } } as ThinkLLMClient;

async function run(args: string[], opts: { client?: ThinkLLMClient; reranker?: boolean } = {}): Promise<{ rows: any[]; summary: any; err: string }> {
  const out = join(tmp, `out-${Math.random().toString(36).slice(2)}.jsonl`);
  const engine: PGLiteEngine = await createBenchmarkBrain();
  const write = process.stderr.write.bind(process.stderr);
  let err = '';
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  try {
    await runEvalLongMemEval([FIXTURE, '--no-embed-cache', '--by-type', ...(opts.reranker ? [] : ['--reranker', 'off']), '--output', out, ...args], {
      engine, exitOnError: false, embedTransport, ...(opts.client ? { client: opts.client } : {}),
      rerankerReadiness: async () => ({ plane: 'db', readiness: { ready: true } }) as never,
    });
  } catch (e) {
    process.stderr.write = write;
    await engine.disconnect();
    throw Object.assign(e as Error, { stderr: err });
  }
  process.stderr.write = write;
  await engine.disconnect();
  const lines = readFileSync(out, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  return { rows: lines.filter((l) => l.kind !== 'by_type_summary'), summary: lines.find((l) => l.kind === 'by_type_summary'), err };
}

const ARM = ['--no-trajectory', '--decide', 'evidence=on', '--decide-threshold', 'evidence=0.5', '--decide-force-on', 'evidence'];

beforeAll(() => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test', TYPESAFE_API_KEY: 'sk-test-typesafe' } });
  __setEmbedTransportForTests(embedTransport);
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.GBRAIN_DECIDE_SLOTS;
  else process.env.GBRAIN_DECIDE_SLOTS = prevEnv;
  enableDecideEvalOverride(false);
  setEvalPoolDepth(null);
  __setDecideTransportForTests(null);
  __resetDecideStoreForTests();
  resetDecideSearchCache();
  answerableP = 0.9;
});

afterAll(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
  rmSync(tmp, { recursive: true, force: true });
});

describe('eval longmemeval --decide', () => {
  test('all-off rows carry no decide field; an S3 arm stamps receipts, run_config.decide and a different hash', async () => {
    decideTransport();
    const base = await run(['--retrieval-only', '--no-trajectory']);
    expect(decideBodies).toHaveLength(0);
    expect(base.rows.every((r) => !('decide' in r))).toBe(true);
    expect(base.summary.run_config.decide).toBeUndefined();

    const arm = await run(['--retrieval-only', ...ARM]);
    expect(decideBodies.length).toBeGreaterThan(0);
    const ev = arm.rows[0].decide.evidence;
    expect(ev).toMatchObject({ mode: 'on', effective: 'on', threshold: 0.5, model_resolved: 'jev-1.13.0' });
    expect(ev.judged).toBeGreaterThan(0);
    expect(ev.outcomes.kept).toBeGreaterThan(0);
    expect(ev.input_tokens).toBeGreaterThan(0);
    expect(typeof ev.cost_usd).toBe('number');
    expect(typeof ev.latency_ms).toBe('number');
    expect(arm.summary.run_config.decide).toMatchObject({ slots: { evidence: 'on' }, gbrain_decide_slots: 'evidence=on', provider: 'typesafe:jev-1.13.0', force_on: ['evidence'], thresholds: { evidence: 0.5 } });
    expect(arm.summary.run_config.decide_summary.evidence.rows).toBe(arm.rows.length);
    expect(arm.rows[0].retrieval_config_hash).not.toBe(base.rows[0].retrieval_config_hash);
    expect(arm.err).toContain('force_on evidence');
  }, 120_000);

  test('S2 intent late answers are flagged per row and rolled up as late_rate', async () => {
    decideTransport();
    const r = await run(['--retrieval-only', '--no-trajectory', '--decide', 'intent=on', '--decide-threshold', 'intent=0.5', '--limit', '2']);
    expect(r.rows[0].decide.intent).toMatchObject({ mode: 'on', late: true, skipped: 'late' });
    expect(r.summary.run_config.decide_summary.intent.late_rate).toBe(1);
  }, 120_000);

  test('--decide answerable=on: the harness reader abstains on the S4 verdict and skips the reader call', async () => {
    decideTransport();
    answerableP = 0.01;
    readerCalls = 0;
    const abstain = await run(['--no-trajectory', '--decide', 'answerable=on', '--decide-threshold', 'answerable=0.5', '--decide-force-on', 'answerable', '--limit', '1'], { client: countingReader });
    const row = abstain.rows[0];
    expect(row.decide.answerable).toMatchObject({ mode: 'on', effective: 'on' });
    expect(row.decide.answerability.verdict).toBe('abstain');
    expect(row.decide.reader_abstained).toBe(true);
    expect(row.hypothesis).toContain('cannot answer');
    expect(readerCalls).toBe(0);
    answerableP = 0.9;
    const pass = await run(['--no-trajectory', '--decide', 'answerable=on', '--decide-threshold', 'answerable=0.5', '--decide-force-on', 'answerable', '--limit', '1'], { client: countingReader });
    expect(pass.rows[0].decide.answerability.verdict).toBe('pass');
    expect(readerCalls).toBe(1);
  }, 120_000);

  test('--decide rerank=on pins the Jev reranker (run_config + hash) and stamps S1 latency and tokens', async () => {
    __setRerankTransportForTests(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(body.questions).map((id, i) => [id, { type: 'score', score: i === 0 ? 3 : 1 }])), usage: { input_tokens: 50 } }));
    });
    const r = await run(['--retrieval-only', '--no-trajectory', '--decide', 'rerank=on', '--limit', '1'], { reranker: true });
    __setRerankTransportForTests(null);
    expect(r.summary.run_config.reranker).toEqual({ enabled: true, model: 'typesafe:jev-1.13.0' });
    expect(r.summary.run_config.search_pins).toMatchObject({ 'search.reranker.model': 'typesafe:jev-1.13.0', 'search.reranker.enabled': 'true' });
    expect(r.summary.run_config.decide.rerank_pinned).toBe('typesafe:jev-1.13.0');
    expect(r.rows[0].decide.rerank).toMatchObject({ mode: 'on', effective: 'on', model_resolved: 'jev-1.13.0' });
    expect(typeof r.rows[0].decide.rerank.latency_ms).toBe('number');
    expect(r.rows[0].decide.rerank.input_tokens).toBeGreaterThan(0);
  }, 120_000);

  test('a --decide arm refuses trajectory routing (question_type labels)', async () => {
    await expect(run(['--retrieval-only', '--decide', 'evidence=on'])).rejects.toThrow('exit 1');
  }, 60_000);

  test('--decide-dataset: eval-half restriction, and a mismatched split is refused with split_mismatch', async () => {
    decideTransport();
    const items = QIDS.map((q) => ({ id: `${q}:s0`, family: q, slot: 'evidence', split: stableSplit(q), state: { query: 'q' }, inputs: { candidate: 'c' }, label: true, rank: 0 }));
    const dataset = join(tmp, 'evidence-dataset.jsonl');
    writeFileSync(dataset, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
    const evalHalf = QIDS.filter((q) => stableSplit(q) === 'eval');
    const cal = (split: string) => {
      const p = join(tmp, `cal-${split}.json`);
      writeFileSync(p, JSON.stringify({ slot: 'evidence', call_site: 'search', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.5, pack_shape: 'x', split_hash: split, calibrate_only: true }));
      return p;
    };
    const good = cal(splitHash(items as never));
    expect(evalHalf.length).toBeGreaterThan(0);
    expect(evalHalf.length).toBeLessThan(QIDS.length);
    const r = await run(['--retrieval-only', ...ARM, '--decide-dataset', dataset, '--decide-calibration', good]);
    expect(r.rows.map((x) => x.question_id).sort()).toEqual([...evalHalf].sort());
    expect(r.summary.run_config.decide).toMatchObject({ split_verified: true, dataset: { name: 'evidence-dataset.jsonl', eval_families: evalHalf.length } });
    let err: any;
    try { await run(['--retrieval-only', ...ARM, '--decide-dataset', dataset, '--decide-calibration', cal('0000000000000000')]); } catch (e) { err = e; }
    expect(err?.message).toContain('exit 1');
    expect(err?.stderr).toContain('split_mismatch');
  }, 120_000);

  test('--capture-pool reports pool_recall at fused depths; --eval-pool-depth pins top_n_in and folds into the hash', async () => {
    const plain = await run(['--retrieval-only', '--no-trajectory', '--capture-pool', '--limit', '1']);
    const pr = plain.rows[0].pool_recall;
    expect(Object.keys(pr.at)).toEqual(['30', '50', '100', '300']);
    expect(pr.fused_pool_size).toBeGreaterThan(0);
    expect(pr.at['300'].all).toBe(true);
    expect(Object.values(pr.gold_rank).every((v) => typeof v === 'number')).toBe(true);
    const deep = await run(['--retrieval-only', '--no-trajectory', '--limit', '1', '--eval-pool-depth', '300']);
    expect(deep.summary.run_config.eval_pool_depth).toBe(300);
    expect(deep.summary.run_config.search_pins).toEqual({ 'search.reranker.top_n_in': '300' });
    expect(deep.rows[0].retrieval_config_hash).not.toBe(plain.rows[0].retrieval_config_hash);
  }, 120_000);
});
