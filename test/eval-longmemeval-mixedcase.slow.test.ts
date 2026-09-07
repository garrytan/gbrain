/**
 * Ranker wave Phase 0 — the like-for-like LongMemEval harness, pinned on the
 * mixed-case `_s`-shaped fixture (test/fixtures/longmemeval-mixedcase.jsonl):
 *
 *   - raw-id join: `sharegpt_yywfIrx_0`-style gold ids match the slug-tail
 *     `chat/sharegpt-yywfirx-0` through the per-question slug→raw map (pre-fix
 *     every recall_hit on the public split was false);
 *   - strict vs lenient: mc-2 has two gold sessions and keyword hits only one
 *     → recall_all_hit=false, recall_any_hit=true;
 *   - `_abs` exclusion by default, inclusion with --include-abstention;
 *   - retrieved[] shape, search_meta, retrieval_config_hash, run_config,
 *     pins landing in engine.getConfig;
 *   - slug collision touching gold → error row; --question-ids; strict
 *     --by-type-floor; resume mixed-config refusal (pins AND non-pin knobs);
 *     reranker preflight exit 2; expansion record + replay + replay-miss
 *     (detected before any import/embed); --record ledger + redaction;
 *   - silent-degradation gates: a vector arm that fell back to keyword-only
 *     or an --expansion that did not run → exit 1 (vector_degraded_rows /
 *     expansion_failed_rows), live AND on a no-op resume (which also records);
 *   - embed-cache transaction scope: a reader failure after import leaves the
 *     question's vectors committed (retry shows misses 0);
 *   - --capture-pool records EVERY pool row (rerank_score optional) + the
 *     autocut kept keys;
 *   - --search-pin: written to config BEFORE the explicit flags (an explicit
 *     --reranker off beats search.reranker.enabled=true), folded into
 *     retrieval_config_hash even for keys the mode resolver never parses, so
 *     an unpinned file cannot be resumed under a pin;
 *   - the reranker preflight + skipped-rows gate key on the RESOLVED pin
 *     (bundle / snapshot / --search-pin), not the --reranker flag alone;
 *   - legacy pre-stamp rows with slug-normalized ids re-score as hits.
 *
 * Hermetic: in-memory PGLite, keyword-only where possible, a deterministic
 * fake embed transport for the expansion path, stubbed readiness. No network.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';
import { redactSecrets, retrievalConfigHash, type KnobsFingerprint, type RetrievalPins } from '../src/eval/longmemeval/run-config.ts';
import { makeStubClient } from './helpers/longmemeval-stub.ts';
import type { ThinkLLMClient } from '../src/core/think/index.ts';
import { checkResumeConfigHash, retrievedIdsAtK } from '../src/eval/longmemeval/resume.ts';
import { rerankerReadiness } from '../src/core/ai/reranker-readiness.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { fnv1a } from '../src/eval/deterministic-embed.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'longmemeval-mixedcase.jsonl');
const BASE = ['--keyword-only', '--retrieval-only', '--no-trajectory', '--by-type', '--top-k', '5'];

let engine: PGLiteEngine;
let tmp: string;
let baseKnobsHash = '';

beforeAll(async () => {
  engine = await createBenchmarkBrain();
  tmp = mkdtempSync(join(tmpdir(), 'lme-mixedcase-'));
});
afterAll(async () => {
  if (engine) await engine.disconnect();
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

function readRows(path: string): any[] {
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}
function splitRows(path: string): { rows: any[]; summary: any } {
  const all = readRows(path);
  const summary = all.find(r => r.kind === 'by_type_summary');
  return { rows: all.filter(r => r.kind !== 'by_type_summary'), summary };
}
function byId(rows: any[]): Record<string, any> {
  return Object.fromEntries(rows.map(r => [r.question_id, r]));
}

/** Run with process.exit captured (the harness exits non-zero on gates). */
async function runCapturingExit(args: string[], runOpts: Parameters<typeof runEvalLongMemEval>[1]): Promise<number | null> {
  let code: number | null = null;
  const originalExit = process.exit;
  // @ts-ignore runtime override for the test
  process.exit = ((c: number) => { code = c; throw new Error('__exit__'); }) as any;
  try {
    await runEvalLongMemEval(args, runOpts);
  } catch (e) {
    if (!String(e).includes('__exit__')) throw e;
  } finally {
    // @ts-ignore runtime restore
    process.exit = originalExit;
  }
  return code;
}

/** Deterministic bag-of-words embedding (1536-d, the preload's legacy schema). */
function fakeVec(text: string): number[] {
  const v = new Array<number>(1536).fill(0);
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) v[fnv1a(tok) % 1536] += 1;
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map(x => x / n);
}
function installFakeEmbedTransport(): { calls: number; fn: any } {
  const state = { calls: 0, fn: null as any };
  state.fn = (async (params: { values: string[] }) => {
    state.calls++;
    return { embeddings: params.values.map(fakeVec), values: params.values, warnings: [], usage: { tokens: params.values.length } };
  }) as any;
  __setEmbedTransportForTests(state.fn);
  return state;
}

describe('mixed-case fixture — raw-id join + strict/lenient recall', () => {
  test('mc-1 recall_all; mc-2 all=false/any=true; _abs excluded by default; pins land in config', async () => {
    const out = join(tmp, 'base.jsonl');
    await runEvalLongMemEval(
      [FIXTURE, ...BASE, '--output', out, '--mode', 'balanced', '--reranker', 'off', '--autocut', 'off', '--expansion-variant-budget', 'legacy'],
      { engine },
    );
    const { rows, summary } = splitRows(out);
    expect(rows).toHaveLength(3);
    const r = byId(rows);

    // Join fix: gold ids are RAW dataset ids, matched through the slug→raw map.
    expect(r['mc-1'].recall_all_hit).toBe(true);
    expect(r['mc-1'].recall_any_hit).toBe(true);
    expect(r['mc-1'].recall_hit).toBe(true); // deprecated alias of recall_any_hit
    expect(r['mc-1'].retrieved_session_ids).toContain('sharegpt_yywfIrx_0');
    expect(r['mc-1'].gold_total).toBe(1);
    expect(r['mc-1'].gold_found).toBe(1);

    // Strict vs lenient: two gold sessions, keyword hits only one.
    expect(r['mc-2'].recall_all_hit).toBe(false);
    expect(r['mc-2'].recall_any_hit).toBe(true);
    expect(r['mc-2'].gold_total).toBe(2);
    expect(r['mc-2'].gold_found).toBe(1);

    // Abstention: emitted, flagged, excluded from the denominators.
    expect(r['mc-3_abs'].abstention).toBe(true);
    expect(r['mc-1'].abstention).toBe(false);

    // retrieved[] shape — every returned chunk row, rank 1-based, RAW ids.
    for (const row of rows) {
      expect(Array.isArray(row.retrieved)).toBe(true);
      row.retrieved.forEach((x: any, i: number) => {
        expect(typeof x.slug).toBe('string');
        expect(typeof x.chunk_id).toBe('number');
        expect(typeof x.session_id).toBe('string');
        expect(x.rank).toBe(i + 1);
        expect(typeof x.score).toBe('number');
      });
      expect(typeof row.distinct_sessions_in_top_k).toBe('number');
      expect(row.distinct_sessions_in_top_k).toBeLessThanOrEqual(5);
      expect(row.gold_missing_from_haystack).toEqual([]);
      expect(row.slug_collision).toBe(0);
      expect(row.retrieval_config_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.search_meta).toEqual({ vector_enabled: false, expansion_applied: false, degraded: [], reranked: false });
      expect(row.mode).toBe('balanced');
      expect(row.error).toBeUndefined();
    }
    // Every row of one run carries the same retrieval_config_hash.
    expect(new Set(rows.map(x => x.retrieval_config_hash)).size).toBe(1);

    // Summary v2.
    expect(summary.schema_version).toBe(2);
    expect(summary.k).toBe(5);
    expect(summary.excluded_abstention).toBe(1);
    expect(summary.aggregate.total).toBe(2);
    expect(summary.aggregate.all_hit).toBe(1);
    expect(summary.aggregate.any_hit).toBe(2);
    expect(summary.recall_by_type['multi-session']).toEqual({ total: 1, all_hit: 0, all_rate: 0, any_hit: 1, any_rate: 1 });
    expect(summary.recall_by_type['single-session-assistant']).toBeUndefined(); // the _abs row
    expect(summary.legacy_rows).toBe(0);
    expect(summary.gold_missing_from_haystack).toBe(0);
    expect(summary.slug_collisions).toBe(0);
    expect(typeof summary.mean_distinct_sessions).toBe('number');
    expect(summary._meta.metric_glossary['recall_all@5']).toContain('EVERY gold session');

    // run_config receipt.
    const rc = summary.run_config;
    expect(rc.mode).toBe('balanced');
    expect(rc.keyword_only).toBe(true);
    expect(rc.reranker).toEqual({ enabled: false, model: expect.any(String) });
    expect(rc.autocut).toBe(false);
    expect(rc.expansion).toBe(false);
    expect(rc.expansion_variant_budget).toBeNull();
    expect(rc.topK).toBe(5);
    expect(rc.trajectory).toBe(false);
    expect(rc.dataset_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rc.dataset_questions).toBe(3);
    expect(rc.retrieval_config_hash).toBe(rows[0].retrieval_config_hash);
    expect(rc.knobs_hash).toMatch(/^[0-9a-f]{16}$/);
    baseKnobsHash = rc.knobs_hash;
    expect(rc.knobs_hash_version).toBe(29);
    expect(rc.cache).toBeNull();
    expect(rc.cache_skipped).toBe('keyword_only');
    expect(rc.reranker_skipped_rows).toBe(0);
    expect(rc.vector_degraded_rows).toBe(0);
    expect(rc.expansion_failed_rows).toBe(0);
    expect(rc.expansion_replay_miss).toBe(0);
    expect(rc.excluded_abstention).toBe(1);
    expect(rc.errors).toBe(0);

    // Pins landed in the benchmark engine's config table.
    expect(await engine.getConfig('search.mode')).toBe('balanced');
    expect(await engine.getConfig('search.reranker.enabled')).toBe('false');
    expect(await engine.getConfig('search.autocut')).toBe('false');
    expect(await engine.getConfig('search.expansion_variant_budget')).toBe('legacy');
  }, 60_000);

  test('--include-abstention counts the _abs row (gold hit) in the denominators', async () => {
    const out = join(tmp, 'abs.jsonl');
    await runEvalLongMemEval([FIXTURE, ...BASE, '--include-abstention', '--output', out], { engine });
    const { rows, summary } = splitRows(out);
    expect(byId(rows)['mc-3_abs'].abstention).toBe(true);
    expect(byId(rows)['mc-3_abs'].recall_all_hit).toBe(true);
    expect(summary.excluded_abstention).toBe(0);
    expect(summary.aggregate.total).toBe(3);
    expect(summary.recall_by_type['single-session-assistant'].total).toBe(1);
  }, 60_000);

  test('--expansion-variant-budget 0.5 pins the numeric value', async () => {
    const out = join(tmp, 'budget.jsonl');
    await runEvalLongMemEval([FIXTURE, ...BASE, '--limit', '1', '--expansion-variant-budget', '0.5', '--output', out], { engine });
    expect(await engine.getConfig('search.expansion_variant_budget')).toBe('0.5');
    const { summary } = splitRows(out);
    expect(summary.run_config.expansion_variant_budget).toBe(0.5);
    // The budget is part of the knobs hash (evb= part, v29): a different budget re-keys.
    expect(summary.run_config.knobs_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(summary.run_config.knobs_hash).not.toBe(baseKnobsHash);
  }, 60_000);
});

describe('slug collision touching gold → error row (plan D32)', () => {
  test('raw ids a_b and a-b collide on the slug; gold on one of them aborts the question', async () => {
    const fixture = join(tmp, 'collision.jsonl');
    const clean = readRows(FIXTURE)[0];
    const colliding = {
      question_id: 'col-1',
      question_type: 'single-session-user',
      question: 'what did alice-example want to buy for the river trip',
      answer: 'a kayak',
      haystack_session_ids: ['alpha_b', 'alpha-b', 'Other_1'],
      haystack_sessions: [
        [{ role: 'user', content: 'alice-example wants to buy a kayak for the river trip.' }, { role: 'assistant', content: 'A kayak is a fine choice for a river trip.' }],
        [{ role: 'user', content: 'Unrelated placeholder about widget-co invoices.' }, { role: 'assistant', content: 'Placeholder reply about invoices.' }],
        [{ role: 'user', content: 'Placeholder about fund-a reserves.' }, { role: 'assistant', content: 'Placeholder reply about reserves.' }],
      ],
      answer_session_ids: ['alpha_b'],
    };
    writeFileSync(fixture, JSON.stringify(colliding) + '\n' + JSON.stringify(clean) + '\n', 'utf8');
    const out = join(tmp, 'collision-out.jsonl');
    await runEvalLongMemEval([fixture, ...BASE, '--output', out], { engine });
    const { rows, summary } = splitRows(out);
    const r = byId(rows);
    expect(r['col-1'].error).toContain('slug_collision');
    expect(r['col-1'].hypothesis).toBe('');
    expect(r['col-1'].slug_collision).toBe(1);
    expect(r['col-1'].slug_collision_gold).toEqual(['chat/alpha-b']);
    expect(r['col-1'].recall_all_hit).toBeUndefined();
    // The run continued: the clean question still scored.
    expect(r['mc-1'].recall_all_hit).toBe(true);
    expect(summary.aggregate.total).toBe(1);
    expect(summary.slug_collisions).toBe(1);
    expect(summary.run_config.slug_collisions).toBe(1);
    expect(summary.run_config.errors).toBe(1);

    // A resume of the same file re-derives the SAME integrity counters: the
    // prior collision-abort error row is dropped (col-1 re-runs and aborts
    // again → counted once by the live path), mc-1 is re-scored from the file.
    await runEvalLongMemEval([fixture, ...BASE, '--output', out, '--resume-from', out], { engine });
    const resumed = splitRows(out);
    // Appended during the run (prior error row + retry row), then compacted to one row per question_id (last wins).
    expect(resumed.rows.map(r => r.question_id)).toEqual(['col-1', 'mc-1']);
    expect(resumed.rows.find(r => r.question_id === 'col-1')!.error).toContain('slug_collision'); // the RETRY's abort row is the survivor
    expect(resumed.summary.run_config.slug_collisions).toBe(summary.run_config.slug_collisions);
    expect(resumed.summary.run_config.gold_missing_from_haystack).toBe(summary.run_config.gold_missing_from_haystack);
    expect(resumed.summary.slug_collisions).toBe(1);
    expect(resumed.summary.aggregate.total).toBe(1);
  }, 120_000);
});

describe('--question-ids (dev slice)', () => {
  test('filters to the listed ids in dataset order; comments and blanks ignored', async () => {
    const ids = join(tmp, 'ids.txt');
    writeFileSync(ids, '# dev slice\n\nmc-2\n', 'utf8');
    const out = join(tmp, 'ids-out.jsonl');
    await runEvalLongMemEval([FIXTURE, ...BASE, '--question-ids', ids, '--output', out], { engine });
    const { rows, summary } = splitRows(out);
    expect(rows.map(r => r.question_id)).toEqual(['mc-2']);
    expect(summary.run_config.question_ids_file).toBe(ids);
  }, 60_000);

  test('an id missing from the dataset exits 1 before any question runs', async () => {
    const ids = join(tmp, 'bad-ids.txt');
    writeFileSync(ids, 'mc-2\nnot-a-question\n', 'utf8');
    const out = join(tmp, 'bad-ids-out.jsonl');
    const code = await runCapturingExit([FIXTURE, ...BASE, '--question-ids', ids, '--output', out], { engine });
    expect(code).toBe(1);
    expect(existsSync(out)).toBe(false);
  }, 60_000);
});

describe('--by-type-floor gates on recall_all (strict) by default', () => {
  test('mc-2 (any=true, all=false) fails the floor; --by-type-floor-metric recall_any restores the lenient gate', async () => {
    const out1 = join(tmp, 'floor-all.jsonl');
    const strict = await runCapturingExit([FIXTURE, ...BASE, '--by-type-floor', '0.5', '--output', out1], { engine });
    expect(strict).toBe(1);
    // The summary was still emitted before the gate fired.
    expect(splitRows(out1).summary.recall_by_type['multi-session'].all_rate).toBe(0);

    const out2 = join(tmp, 'floor-any.jsonl');
    const lenient = await runCapturingExit(
      [FIXTURE, ...BASE, '--by-type-floor', '0.5', '--by-type-floor-metric', 'recall_any', '--output', out2],
      { engine },
    );
    expect(lenient).toBeNull();
    expect(splitRows(out2).summary.recall_by_type['multi-session'].any_rate).toBe(1);
  }, 60_000);
});

describe('resume: retrieval_config_hash gate (plan D33) + re-scoring', () => {
  test('a resume file written under different pins is refused; --allow-mixed-run-config proceeds', async () => {
    const out = join(tmp, 'resume.jsonl');
    await runEvalLongMemEval([FIXTURE, ...BASE, '--limit', '2', '--output', out], { engine });
    const firstRows = splitRows(out).rows;
    expect(firstRows).toHaveLength(2);

    // Different top-k → different retrieval_config_hash → refused.
    const refused = await runCapturingExit(
      [FIXTURE, '--keyword-only', '--retrieval-only', '--no-trajectory', '--by-type', '--top-k', '3', '--output', out, '--resume-from', out],
      { engine },
    );
    expect(refused).toBe(1);
    // Nothing was appended by the refused run.
    expect(splitRows(out).rows).toHaveLength(2);

    // Same eight pins but an injected snapshot that differs in a NON-pin knob
    // (autocut_jump rides the knobs hash) → different retrieval_config_hash →
    // refused too. Pre-fix the hash covered only the pins and this merged.
    const refusedKnob = await runCapturingExit(
      [FIXTURE, ...BASE, '--output', out, '--resume-from', out],
      { engine, searchConfigSnapshot: { 'search.autocut_jump': '0.5' } },
    );
    expect(refusedKnob).toBe(1);
    expect(splitRows(out).rows).toHaveLength(2);

    // Same pins → resumes the remaining question, cumulative summary.
    await runEvalLongMemEval([FIXTURE, ...BASE, '--output', out, '--resume-from', out], { engine });
    const same = splitRows(out);
    expect(same.rows).toHaveLength(3);
    expect(same.summary.aggregate.total).toBe(2); // mc-1 + mc-2; _abs excluded
    expect(same.summary.aggregate.all_hit).toBe(1);
    expect(same.summary.excluded_abstention).toBe(1);

    // Mixed pins, explicitly allowed → proceeds (no-op resume, summary re-emitted).
    const allowed = await runCapturingExit(
      [FIXTURE, '--keyword-only', '--retrieval-only', '--no-trajectory', '--by-type', '--top-k', '3', '--output', out, '--resume-from', out, '--allow-mixed-run-config'],
      { engine },
    );
    expect(allowed).toBeNull();
    const mixed = splitRows(out);
    expect(mixed.rows).toHaveLength(3);
    expect(mixed.summary.k).toBe(3);
  }, 120_000);

  test('checkResumeConfigHash / retrievedIdsAtK (pure)', () => {
    const rows = [
      { question_id: 'a', hypothesis: 'x', retrieval_config_hash: 'h1' },
      { question_id: 'b', hypothesis: 'x', retrieval_config_hash: 'h2' },
      { question_id: 'c', hypothesis: 'x' },
      { question_id: 'd', hypothesis: '', error: 'boom', retrieval_config_hash: 'h9' },
      { kind: 'by_type_summary', retrieval_config_hash: 'h9' },
    ];
    expect(checkResumeConfigHash(rows, 'h1')).toEqual({ mismatched: 1, unstamped: 1, foreign: ['h2'] });
    expect(retrievedIdsAtK({ retrieved: [{ session_id: 's1' }, { session_id: 's1' }, { session_id: 's2' }, { session_id: 's3' }] }, 3)).toEqual(['s1', 's2']);
    expect(retrievedIdsAtK({ retrieved_session_ids: ['s1', 's2', 's3'] }, 2)).toEqual(['s1', 's2']);
    expect(retrievedIdsAtK({}, 5)).toEqual([]);
  });

  test('retrievalConfigHash is order-independent, pin-sensitive AND knobs-hash-sensitive', () => {
    const pins: RetrievalPins = {
      mode: 'balanced', keyword_only: false, reranker: { enabled: true, model: 'voyage:rerank-2.5' }, autocut: true,
      expansion: false, expansion_variant_budget: null, embedder: 'openai:text-embedding-3-large@1536', top_k: 5, trajectory: false,
    };
    const knobs: KnobsFingerprint = { knobs_hash: 'a1b2c3d4e5f60718', knobs_hash_version: 29 };
    const reordered = { trajectory: false, top_k: 5, embedder: pins.embedder, expansion_variant_budget: null, expansion: false, autocut: true, reranker: { model: 'voyage:rerank-2.5', enabled: true }, keyword_only: false, mode: 'balanced' } as RetrievalPins;
    expect(retrievalConfigHash(pins, knobs)).toBe(retrievalConfigHash(reordered, knobs));
    expect(retrievalConfigHash(pins, knobs)).toMatch(/^[0-9a-f]{64}$/);
    expect(retrievalConfigHash({ ...pins, top_k: 6 }, knobs)).not.toBe(retrievalConfigHash(pins, knobs));
    expect(retrievalConfigHash({ ...pins, expansion_variant_budget: 0.5 }, knobs)).not.toBe(retrievalConfigHash(pins, knobs));
    // Same pins, different resolved knobs (a non-pin knob moved) → different hash.
    expect(retrievalConfigHash(pins, { ...knobs, knobs_hash: 'ffffffffffffffff' })).not.toBe(retrievalConfigHash(pins, knobs));
    expect(retrievalConfigHash(pins, { ...knobs, knobs_hash_version: 30 })).not.toBe(retrievalConfigHash(pins, knobs));
  });
});

describe('no-op resume runs the FULL run-end block (gates + --record)', () => {
  test('all questions done, prior rows degraded → reranker + vector gates fire (exit 1), summary emitted, ledger records status failed', async () => {
    const out = join(tmp, 'noop-resume.jsonl');
    const recordDir = join(tmp, 'noop-ledger');
    const qs = readRows(FIXTURE);
    // Every prior row "completed" but silently degraded: keyword-only fallback
    // (vector_enabled:false + embed_unavailable) and an un-reranked pass-through.
    writeFileSync(out, qs.map(q => JSON.stringify({
      question_id: q.question_id, question: q.question, question_type: q.question_type, hypothesis: 'done',
      retrieved_session_ids: q.answer_session_ids ?? [],
      search_meta: { vector_enabled: false, expansion_applied: false, degraded: [{ stage: 'embed_unavailable', reason: 'provider_error' }, { stage: 'reranker_skipped', reason: 'no_key' }], reranked: false },
    })).join('\n') + '\n', 'utf8');
    // Non-keyword-only run with --reranker on: the no-op branch returns before
    // any engine/gateway work, so no transport or readiness stub is needed.
    const code = await runCapturingExit(
      [FIXTURE, '--retrieval-only', '--no-trajectory', '--by-type', '--top-k', '5', '--reranker', 'on', '--record', '--output', out, '--resume-from', out],
      { engine, recordDir },
    );
    expect(code).toBe(1);
    const { rows, summary } = splitRows(out);
    expect(rows).toHaveLength(3); // nothing appended
    expect(summary.schema_version).toBe(2);
    expect(summary.run_config.cache_skipped).toBe('resume_noop');
    expect(summary.run_config.reranker_skipped_rows).toBe(3);
    expect(summary.run_config.vector_degraded_rows).toBe(3);
    expect(summary.run_config.expansion_failed_rows).toBe(0);
    // --record wrote a ledger row (pre-fix the no-op branch returned before it).
    const ledger = readRows(join(recordDir, 'eval-results.jsonl'));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('failed');
    expect(ledger[0].error).toContain('exit 1');
    expect(ledger[0].params.questions_run).toBe(0);
    expect(ledger[0].params.vector_degraded_rows).toBe(3);
    expect(ledger[0].params.reranker_skipped_rows).toBe(3);
  }, 60_000);

  test('a keyword-only no-op resume ignores vector_enabled:false (no vector arm was configured)', async () => {
    const out = join(tmp, 'noop-resume-kw.jsonl');
    const qs = readRows(FIXTURE);
    writeFileSync(out, qs.map(q => JSON.stringify({
      question_id: q.question_id, question: q.question, question_type: q.question_type, hypothesis: 'done',
      retrieved_session_ids: q.answer_session_ids ?? [],
      search_meta: { vector_enabled: false, expansion_applied: false, degraded: [], reranked: false },
    })).join('\n') + '\n', 'utf8');
    const code = await runCapturingExit([FIXTURE, ...BASE, '--output', out, '--resume-from', out], { engine });
    expect(code).toBeNull();
    expect(splitRows(out).summary.run_config.vector_degraded_rows).toBe(0);
  }, 60_000);
});

describe('silent vector-arm / expansion degradation is a gate (mirrors --reranker on)', () => {
  const VECTOR_COMMON = [FIXTURE, '--retrieval-only', '--no-trajectory', '--by-type', '--top-k', '5', '--mode', 'balanced', '--reranker', 'off', '--autocut', 'off', '--no-embed-cache'];

  function gateway1536(): void {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
  }

  test('a query-side embed failure scores the row keyword-only → vector_degraded_rows > 0 and exit 1', async () => {
    gateway1536();
    const questionTexts = new Set(readRows(FIXTURE).map(r => r.question as string));
    // Documents embed fine (import must succeed); the QUERY embed fails, which
    // hybridSearch swallows into degraded[embed_unavailable] + vector_enabled:false.
    __setEmbedTransportForTests((async (params: { values: string[] }) => {
      if (params.values.some(v => questionTexts.has(v))) throw new Error('simulated provider outage (query embed)');
      return { embeddings: params.values.map(fakeVec), values: params.values, warnings: [], usage: { tokens: params.values.length } };
    }) as any);
    const out = join(tmp, 'vector-degraded.jsonl');
    const code = await runCapturingExit([...VECTOR_COMMON, '--output', out], { engine });
    expect(code).toBe(1);
    const { rows, summary } = splitRows(out);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.error).toBeUndefined(); // the row was scored — just not by the configured arm
      expect(row.search_meta.vector_enabled).toBe(false);
      expect(row.search_meta.degraded.map((d: any) => d.stage)).toContain('embed_unavailable');
    }
    expect(summary.run_config.vector_degraded_rows).toBe(3);
    expect(summary.run_config.expansion_failed_rows).toBe(0);
    expect(summary.run_config.errors).toBe(0);
  }, 120_000);

  test('a healthy vector arm passes the gate (exit 0, vector_degraded_rows 0)', async () => {
    gateway1536();
    installFakeEmbedTransport();
    const out = join(tmp, 'vector-healthy.jsonl');
    const code = await runCapturingExit([...VECTOR_COMMON, '--limit', '1', '--output', out], { engine });
    expect(code).toBeNull();
    const { rows, summary } = splitRows(out);
    expect(rows[0].search_meta.vector_enabled).toBe(true);
    expect(summary.run_config.vector_degraded_rows).toBe(0);
  }, 120_000);

  test('a PARTIAL resume without --by-type still folds prior-row degradation into the gate (exit 1; live row healthy)', async () => {
    gateway1536();
    installFakeEmbedTransport();
    const out = join(tmp, 'partial-resume-degraded.jsonl');
    const recordDir = join(tmp, 'partial-resume-ledger');
    // Two prior rows scored keyword-only after a silent embed failure; the third question is left for this run.
    writeFileSync(out, readRows(FIXTURE).filter(q => q.question_id !== 'mc-3_abs').map(q => JSON.stringify({
      question_id: q.question_id, question: q.question, question_type: q.question_type, hypothesis: 'done',
      retrieved_session_ids: q.answer_session_ids ?? [],
      search_meta: { vector_enabled: false, expansion_applied: false, degraded: [{ stage: 'embed_unavailable', reason: 'provider_error' }], reranked: false },
    })).join('\n') + '\n', 'utf8');
    const code = await runCapturingExit(
      [...VECTOR_COMMON.filter(a => a !== '--by-type'), '--record', '--output', out, '--resume-from', out],
      { engine, recordDir },
    );
    expect(code).toBe(1);
    const rows = readRows(out);
    expect(rows.map(r => r.question_id)).toEqual(['mc-1', 'mc-2', 'mc-3_abs']); // appended; no summary line without --by-type
    expect(rows[2].search_meta.vector_enabled).toBe(true); // the live row is healthy — the gate fired on the PRIOR rows
    const ledger = readRows(join(recordDir, 'eval-results.jsonl'));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('failed');
    expect(ledger[0].params.questions_run).toBe(1);
    expect(ledger[0].params.vector_degraded_rows).toBe(2);
  }, 120_000);

  test('--expansion whose expandFn throws → expansion_failed_rows > 0 and exit 1 (vector arm itself healthy)', async () => {
    gateway1536();
    installFakeEmbedTransport();
    const out = join(tmp, 'expansion-failed.jsonl');
    const code = await runCapturingExit(
      [...VECTOR_COMMON, '--expansion', '--limit', '1', '--output', out],
      { engine, expandFn: async () => { throw new Error('simulated expansion provider outage'); } },
    );
    expect(code).toBe(1);
    const { rows, summary } = splitRows(out);
    expect(rows[0].error).toBeUndefined();
    expect(rows[0].search_meta.vector_enabled).toBe(true);
    expect(rows[0].search_meta.degraded.map((d: any) => d.stage)).toContain('expansion_failed');
    expect(summary.run_config.expansion_failed_rows).toBe(1);
    expect(summary.run_config.vector_degraded_rows).toBe(0);
  }, 120_000);
});

describe('reranker preflight keys on the RESOLVED pin', () => {
  const NON_KW = [FIXTURE, '--retrieval-only', '--no-trajectory', '--by-type', '--top-k', '5'];
  const notReady = async (_engine: PGLiteEngine, model: string) => ({ plane: 'config' as const, readiness: rerankerReadiness(model, {}) }); // no provider key → not ready

  test('--reranker on + a not-ready reranker exits 2 with the fix text before any question runs', async () => {
    const out = join(tmp, 'preflight.jsonl');
    const code = await runCapturingExit([...NON_KW, '--reranker', 'on', '--output', out], { engine, rerankerReadiness: notReady });
    expect(code).toBe(2);
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  test('NO --reranker flag: the balanced bundle turns the reranker on → the same preflight fires (exit 2); --reranker off skips it', async () => {
    const out = join(tmp, 'preflight-bundle.jsonl');
    let probes = 0;
    const probe = async (e: PGLiteEngine, model: string) => { probes++; return notReady(e, model); };
    const code = await runCapturingExit([...NON_KW, '--mode', 'balanced', '--output', out], { engine, rerankerReadiness: probe });
    expect(code).toBe(2);
    expect(probes).toBe(1);
    expect(existsSync(out)).toBe(false);
    // A --search-pin turning it on is a resolved pin too.
    const viaPin = await runCapturingExit([...NON_KW, '--mode', 'conservative', '--search-pin', 'search.reranker.enabled=true', '--output', out], { engine, rerankerReadiness: probe });
    expect(viaPin).toBe(2);
    expect(probes).toBe(2);
    // The explicit flag beats the bundle: no probe, and the run proceeds past the preflight
    // (keyword-only here so no embed transport is needed).
    const off = await runCapturingExit([FIXTURE, ...BASE, '--limit', '1', '--mode', 'balanced', '--output', out], { engine, rerankerReadiness: probe });
    expect(off).toBeNull();
    expect(probes).toBe(2);
  }, 60_000);

  test('--keyword-only resolves the reranker pin OFF: --reranker on never probes and the run proceeds', async () => {
    const out = join(tmp, 'preflight-kw.jsonl');
    let probes = 0;
    const code = await runCapturingExit(
      [FIXTURE, ...BASE, '--limit', '1', '--reranker', 'on', '--output', out],
      { engine, rerankerReadiness: async (e, model) => { probes++; return notReady(e, model); } },
    );
    expect(code).toBeNull();
    expect(probes).toBe(0);
    expect(await engine.getConfig('search.reranker.enabled')).toBe('true'); // the pin is still written
    const { rows, summary } = splitRows(out);
    expect(rows).toHaveLength(1);
    expect(summary.run_config.reranker.enabled).toBe(false);
  }, 60_000);
});

describe('reranker skipped-rows gate keys on the RESOLVED pin (no --reranker flag)', () => {
  const priorDegraded = (out: string) => writeFileSync(out, readRows(FIXTURE).map(q => JSON.stringify({
    question_id: q.question_id, question: q.question, question_type: q.question_type, hypothesis: 'done',
    retrieved_session_ids: q.answer_session_ids ?? [],
    search_meta: { vector_enabled: true, expansion_applied: false, degraded: [{ stage: 'reranker_skipped', reason: 'no_key' }], reranked: false },
  })).join('\n') + '\n', 'utf8');
  const NON_KW = [FIXTURE, '--retrieval-only', '--no-trajectory', '--by-type', '--top-k', '5'];

  test('snapshot-enabled reranker + prior un-reranked rows → exit 1 naming the fix; balanced bundle default → exit 1; --reranker off → exit 0', async () => {
    const out = join(tmp, 'gate-resolved.jsonl');
    priorDegraded(out);
    const viaSnapshot = await runCapturingExit([...NON_KW, '--mode', 'conservative', '--output', out, '--resume-from', out], { engine, searchConfigSnapshot: { 'search.reranker.enabled': 'true' } });
    expect(viaSnapshot).toBe(1);
    let summary = splitRows(out).summary;
    expect(summary.run_config.reranker.enabled).toBe(true);
    expect(summary.run_config.reranker_skipped_rows).toBe(3);

    priorDegraded(out);
    const viaBundle = await runCapturingExit([...NON_KW, '--mode', 'balanced', '--output', out, '--resume-from', out], { engine });
    expect(viaBundle).toBe(1);

    priorDegraded(out);
    const off = await runCapturingExit([...NON_KW, '--mode', 'balanced', '--reranker', 'off', '--output', out, '--resume-from', out], { engine });
    expect(off).toBeNull();
    summary = splitRows(out).summary;
    expect(summary.run_config.reranker.enabled).toBe(false);
    expect(summary.run_config.reranker_skipped_rows).toBe(3); // still counted, no longer a gate
  }, 60_000);
});

describe('--search-pin (generic search.* pins)', () => {
  test('pin lands in config; knobs_hash + retrieval_config_hash re-key; an unpinned file is refused on resume; an UNPARSED key still re-keys retrieval_config_hash', async () => {
    const out = join(tmp, 'pin-base.jsonl');
    await runEvalLongMemEval([FIXTURE, ...BASE, '--limit', '1', '--reranker', 'off', '--autocut', 'off', '--output', out], { engine });
    const base = splitRows(out).summary.run_config;
    expect(base.search_pins).toBeUndefined();
    expect(splitRows(out).rows[0].retrieval_config_hash).toBe(base.retrieval_config_hash);

    // A key the mode resolver parses (autocut_jump) reaches knobs_hash AND retrieval_config_hash.
    const parsed = join(tmp, 'pin-parsed.jsonl');
    await runEvalLongMemEval([FIXTURE, ...BASE, '--limit', '1', '--reranker', 'off', '--autocut', 'off', '--search-pin', 'search.autocut_jump=0.5', '--output', parsed], { engine });
    expect(await engine.getConfig('search.autocut_jump')).toBe('0.5');
    const rcParsed = splitRows(parsed).summary.run_config;
    expect(rcParsed.search_pins).toEqual({ 'search.autocut_jump': '0.5' });
    expect(rcParsed.knobs_hash).not.toBe(base.knobs_hash);
    expect(rcParsed.retrieval_config_hash).not.toBe(base.retrieval_config_hash);

    // A key the resolver does NOT parse changes ranking but never reaches
    // knobs_hash — retrieval_config_hash must still differ (pre-fix it did not).
    const unparsed = join(tmp, 'pin-unparsed.jsonl');
    await runEvalLongMemEval([FIXTURE, ...BASE, '--limit', '1', '--reranker', 'off', '--autocut', 'off', '--search-pin', 'search.adaptive_return=true', '--output', unparsed], { engine });
    expect(await engine.getConfig('search.adaptive_return')).toBe('true');
    const rcUnparsed = splitRows(unparsed).summary.run_config;
    expect(rcUnparsed.search_pins).toEqual({ 'search.adaptive_return': 'true' });
    expect(rcUnparsed.knobs_hash).toBe(base.knobs_hash);
    expect(rcUnparsed.retrieval_config_hash).not.toBe(base.retrieval_config_hash);
    expect(rcUnparsed.retrieval_config_hash).not.toBe(rcParsed.retrieval_config_hash);

    // Resuming the UNPINNED file under the unparsed pin is refused (different hash); a same-pin resume proceeds.
    const refused = await runCapturingExit([FIXTURE, ...BASE, '--reranker', 'off', '--autocut', 'off', '--search-pin', 'search.adaptive_return=true', '--output', out, '--resume-from', out], { engine });
    expect(refused).toBe(1);
    expect(splitRows(out).rows).toHaveLength(1);
    await runEvalLongMemEval([FIXTURE, ...BASE, '--reranker', 'off', '--autocut', 'off', '--search-pin', 'search.adaptive_return=true', '--output', unparsed, '--resume-from', unparsed], { engine });
    expect(splitRows(unparsed).rows).toHaveLength(3);
    expect(splitRows(unparsed).summary.run_config.search_pins).toEqual({ 'search.adaptive_return': 'true' });
  }, 120_000);

  test('an explicit --reranker off / --autocut on beats a --search-pin of the same key: config, resolved pins and the row agree', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
    installFakeEmbedTransport();
    const out = join(tmp, 'pin-beats.jsonl');
    let probes = 0;
    const code = await runCapturingExit(
      [FIXTURE, '--retrieval-only', '--no-trajectory', '--by-type', '--top-k', '5', '--mode', 'balanced', '--no-embed-cache', '--limit', '1', '--output', out,
        '--reranker', 'off', '--autocut', 'on',
        '--search-pin', 'search.reranker.enabled=true', '--search-pin', 'search.autocut=false'],
      { engine, rerankerReadiness: async (_e, model) => { probes++; return { plane: 'config' as const, readiness: rerankerReadiness(model, {}) }; } },
    );
    expect(code).toBeNull();
    expect(probes).toBe(0); // resolved pin is OFF → no preflight, no gate
    // The explicit flags were written LAST, so they are what hybridSearch resolved.
    expect(await engine.getConfig('search.reranker.enabled')).toBe('false');
    expect(await engine.getConfig('search.autocut')).toBe('true');
    const { rows, summary } = splitRows(out);
    expect(summary.run_config.reranker.enabled).toBe(false);
    expect(summary.run_config.autocut).toBe(true);
    expect(summary.run_config.search_pins).toEqual({ 'search.autocut': 'false', 'search.reranker.enabled': 'true' });
    expect(rows[0].search_meta.reranked).toBe(false);
    expect(rows[0].search_meta.degraded.map((d: any) => d.stage)).not.toContain('reranker_skipped');
    expect(rows[0].search_meta.vector_enabled).toBe(true);
  }, 120_000);
});

describe('legacy pre-stamp rows with slug-normalized ids re-score against RAW gold on resume', () => {
  test('a no-op resume of normalized-id rows scores mc-1 + mc-2 as hits (pre-fix: every legacy row was a miss)', async () => {
    const out = join(tmp, 'legacy-ids.jsonl');
    // Pre-v2 rows: no retrieval_config_hash, no retrieved[], ids lowercased with _ → -.
    writeFileSync(out, readRows(FIXTURE).map(q => JSON.stringify({
      question_id: q.question_id, question: q.question, question_type: q.question_type, hypothesis: 'done',
      retrieved_session_ids: (q.answer_session_ids ?? []).map((id: string) => id.toLowerCase().replace(/[_.]/g, '-')),
    })).join('\n') + '\n', 'utf8');
    expect(readRows(out)[0].retrieved_session_ids).toEqual(['sharegpt-yywfirx-0']);
    const code = await runCapturingExit([FIXTURE, ...BASE, '--output', out, '--resume-from', out], { engine });
    expect(code).toBeNull();
    const { rows, summary } = splitRows(out);
    expect(rows).toHaveLength(3); // nothing re-run
    expect(summary.aggregate).toMatchObject({ total: 2, all_hit: 2, any_hit: 2 });
    expect(summary.recall_by_type['multi-session']).toMatchObject({ total: 1, all_hit: 1 });
    expect(summary.excluded_abstention).toBe(1);
  }, 60_000);
});

describe('expansion: record → replay → replay miss', () => {
  const VARIANTS = ['alice-example kayak brand for the river trip', 'which kayak did alice-example choose'];

  test('--expansion records expansion_variants; --expansion-replay serves them without calling expandFn; a missing id is an error row + exit 1', async () => {
    // The embed recipe demands a key even when a test transport serves the
    // call (longmemeval-embed-cache.test.ts precedent) — a fake one suffices.
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
    const fake = installFakeEmbedTransport();
    const cachePath = join(tmp, 'embed-cache.sqlite');
    let expandCalls = 0;
    const expandFn = async (q: string) => { expandCalls++; return [q, ...VARIANTS]; };
    const common = [FIXTURE, '--retrieval-only', '--no-trajectory', '--by-type', '--top-k', '5', '--mode', 'balanced', '--reranker', 'off', '--autocut', 'off', '--embed-cache', cachePath];

    // Record.
    const recorded = join(tmp, 'expansion-record.jsonl');
    await runEvalLongMemEval([...common, '--expansion', '--question-ids', writeIds('rec-ids.txt', ['mc-1', 'mc-2']), '--output', recorded], { engine, expandFn, embedTransport: fake.fn });
    const rec = splitRows(recorded);
    expect(expandCalls).toBe(2);
    for (const row of rec.rows) {
      expect(row.error).toBeUndefined();
      expect(row.expansion_variants).toEqual([row.question, ...VARIANTS]);
      expect(row.expansion_replayed).toBeUndefined();
      expect(row.search_meta.vector_enabled).toBe(true);
      expect(row.search_meta.expansion_applied).toBe(true);
      expect(row.search_meta.reranked).toBe(false);
    }
    expect(rec.summary.run_config.expansion).toBe(true);
    expect(rec.summary.run_config.expansion_replay).toBeNull();
    expect(rec.summary.run_config.cache.path).toBe(cachePath);
    expect(rec.summary.run_config.cache.misses).toBeGreaterThan(0);
    expect(rec.summary.run_config.cache.infra_faults).toBe(0);
    expect(rec.summary.run_config.cache.canonical_sha256).toMatch(/^[0-9a-f]{64}$/);

    // Replay: same variants served from the file, expandFn never called,
    // and every embed is a cache hit (plan D28: replay arms show 0 misses).
    expandCalls = 0;
    const replayed = join(tmp, 'expansion-replay.jsonl');
    await runEvalLongMemEval([...common, '--expansion-replay', recorded, '--question-ids', writeIds('rep-ids.txt', ['mc-1', 'mc-2']), '--output', replayed], { engine, expandFn, embedTransport: fake.fn });
    const rep = splitRows(replayed);
    expect(expandCalls).toBe(0);
    for (const row of rep.rows) {
      expect(row.error).toBeUndefined();
      expect(row.expansion_variants).toEqual([row.question, ...VARIANTS]);
      expect(row.expansion_replayed).toBe(true);
      expect(row.search_meta.expansion_applied).toBe(true);
    }
    expect(rep.summary.run_config.expansion_replay).toBe(recorded);
    expect(rep.summary.run_config.cache.misses).toBe(0);
    expect(rep.summary.run_config.cache.hits).toBeGreaterThan(0);
    expect(rep.summary.run_config.cache.canonical_sha256).toBe(rec.summary.run_config.cache.canonical_sha256);
    // Same pins → same retrieval_config_hash across record and replay.
    expect(rep.rows[0].retrieval_config_hash).toBe(rec.rows[0].retrieval_config_hash);

    // Replay miss: mc-3_abs has no recorded variants → error row, exit 1 at the end.
    const missed = join(tmp, 'expansion-miss.jsonl');
    const code = await runCapturingExit([...common, '--expansion-replay', recorded, '--output', missed], { engine, expandFn, embedTransport: fake.fn });
    expect(code).toBe(1);
    const miss = splitRows(missed);
    const r = byId(miss.rows);
    expect(r['mc-3_abs'].expansion_replay_miss).toBe(true);
    expect(r['mc-3_abs'].error).toContain('expansion_replay_miss');
    expect(r['mc-1'].error).toBeUndefined();
    expect(miss.summary.run_config.expansion_replay_miss).toBe(1);
    expect(expandCalls).toBe(0);
  }, 180_000);

  test('a replay miss aborts BEFORE resetTables / import / any embed call (zero transport calls, page table untouched)', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
    const fake = installFakeEmbedTransport();
    // A replay file from "another dataset": variants recorded for an id that is not mc-1.
    const foreign = join(tmp, 'foreign-replay.jsonl');
    writeFileSync(foreign, JSON.stringify({ question_id: 'not-in-this-dataset', expansion_variants: ['x', 'y'] }) + '\n', 'utf8');
    const pagesBefore = (await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM pages'))[0].n;
    const out = join(tmp, 'replay-miss-early.jsonl');
    const code = await runCapturingExit(
      // --reranker off: the balanced bundle turns the reranker ON, and the resolved-pin
      // preflight would otherwise exit 2 (no key) before the replay-miss path is reached.
      [FIXTURE, '--retrieval-only', '--no-trajectory', '--by-type', '--top-k', '5', '--reranker', 'off', '--no-embed-cache', '--expansion-replay', foreign, '--question-ids', writeIds('miss-ids.txt', ['mc-1']), '--output', out],
      { engine, expandFn: async () => { throw new Error('expandFn must not run on replay'); } },
    );
    expect(code).toBe(1);
    const r = byId(splitRows(out).rows);
    expect(r['mc-1'].expansion_replay_miss).toBe(true);
    expect(r['mc-1'].error).toContain('expansion_replay_miss');
    // Pre-fix the haystack was imported (and embedded) before the miss was
    // detected. Now: no embed call happened and the page table was never
    // reset/re-filled for the aborted question.
    expect(fake.calls).toBe(0);
    const pagesAfter = (await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM pages'))[0].n;
    expect(pagesAfter).toBe(pagesBefore);
  }, 120_000);

  test('embed-cache transaction is scoped to import+search: a reader failure leaves the vectors committed (retry: misses 0)', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
    const fake = installFakeEmbedTransport();
    const cachePath = join(tmp, 'tx-scope-cache.sqlite');
    const common = [FIXTURE, '--no-trajectory', '--by-type', '--top-k', '5', '--mode', 'balanced', '--reranker', 'off', '--autocut', 'off', '--embed-cache', cachePath, '--question-ids', writeIds('tx-ids.txt', ['mc-1'])];
    // Run 1: the reader (answer LLM) throws AFTER import + search.
    const failingClient: ThinkLLMClient = { create: async () => { throw new Error('reader boom (simulated)'); } };
    const out1 = join(tmp, 'tx-scope-1.jsonl');
    // The only question errors → an all-errored run exits 1 (the loop still ran; that is what we probe).
    const failedCode = await runCapturingExit([...common, '--output', out1], { engine, client: failingClient, embedTransport: fake.fn });
    expect(failedCode).toBe(1);
    const run1 = splitRows(out1);
    expect(byId(run1.rows)['mc-1'].error).toContain('reader boom');
    expect(run1.summary.run_config.errors).toBe(1);
    // Vectors were produced (misses > 0) — and, post-fix, COMMITTED despite the
    // reader failure (pre-fix the whole question was one transaction and the
    // failure rolled every put back).
    expect(run1.summary.run_config.cache.misses).toBeGreaterThan(0);
    const embedsRun1 = fake.calls;
    expect(embedsRun1).toBeGreaterThan(0);
    // Run 2: same question, working reader → every embed is a cache hit.
    const { client } = makeStubClient('retried-answer');
    const out2 = join(tmp, 'tx-scope-2.jsonl');
    await runEvalLongMemEval([...common, '--output', out2], { engine, client, embedTransport: fake.fn });
    const run2 = splitRows(out2);
    expect(byId(run2.rows)['mc-1'].hypothesis).toContain('retried-answer');
    expect(run2.summary.run_config.cache.misses).toBe(0);
    expect(run2.summary.run_config.cache.hits).toBeGreaterThan(0);
    expect(run2.summary.run_config.cache.infra_faults).toBe(0);
    expect(fake.calls).toBe(embedsRun1); // no transport call in run 2
  }, 180_000);

  test('--capture-pool records EVERY pool row (rerank_score optional, pool_rank positional) + autocut_kept_keys', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
    installFakeEmbedTransport();
    const out = join(tmp, 'capture-pool.jsonl');
    // Reranker OFF: no row carries a rerank_score — pre-fix the finite-score
    // filter recorded an EMPTY pool here. Autocut ON: a decision is recorded
    // (applied:false — nothing scored to cut on); --top-k 50 so the limit
    // slice never hides the kept set.
    await runEvalLongMemEval(
      [FIXTURE, '--retrieval-only', '--no-trajectory', '--by-type', '--top-k', '50', '--mode', 'balanced', '--reranker', 'off', '--autocut', 'on', '--no-embed-cache', '--capture-pool', '--question-ids', writeIds('pool-ids.txt', ['mc-1', 'mc-2']), '--output', out],
      { engine },
    );
    const { rows } = splitRows(out);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.error).toBeUndefined();
      expect(Array.isArray(row.rerank_pool)).toBe(true);
      expect(row.rerank_pool.length).toBeGreaterThan(0);
      const poolKeys = new Set<string>();
      row.rerank_pool.forEach((p: any, i: number) => {
        expect(typeof p.slug).toBe('string');
        expect(typeof p.chunk_id).toBe('number');
        expect(typeof p.session_id).toBe('string');
        expect(p.pool_rank).toBe(i + 1);
        expect(Number.isInteger(p.rrf_rank) && p.rrf_rank >= 1).toBe(true);
        expect(typeof p.est_tokens).toBe('number');
        expect(p.rerank_score).toBeUndefined(); // reranker off → absent, row still recorded
        expect(p.alias_hit).toBeUndefined();
        expect(p.exact_lookup).toBeUndefined();
        poolKeys.add(`${p.slug}#${p.chunk_id}`);
      });
      // The returned rows are drawn from the captured pool.
      const retrievedKeys = row.retrieved.map((r: any) => `${r.slug}#${r.chunk_id}`);
      for (const k of retrievedKeys) expect(poolKeys.has(k)).toBe(true);
      // Autocut ran (decision recorded) and, with the kept count equal to the
      // returned rows, the exact kept set is recorded as slug#chunk_id keys.
      expect(row.search_meta.autocut).toBeDefined();
      expect(row.search_meta.autocut.applied).toBe(false);
      if (row.search_meta.autocut.kept === row.retrieved.length) {
        expect(row.autocut_kept_keys).toEqual(retrievedKeys);
      }
    }
    // The pool + kept keys must be present for the autocut-floor replay on at least one row.
    expect(rows.some(r => Array.isArray(r.autocut_kept_keys) && r.autocut_kept_keys.length > 0)).toBe(true);
  }, 120_000);

  function writeIds(name: string, ids: string[]): string {
    const p = join(tmp, name);
    writeFileSync(p, ids.join('\n') + '\n', 'utf8');
    return p;
  }
});

describe('--record appends an EvalRunRecord (redacted)', () => {
  test('ledger row: suite longmemeval, params = run_config + aggregate, status completed', async () => {
    const recordDir = join(tmp, 'ledger');
    const out = join(tmp, 'record.jsonl');
    await runEvalLongMemEval([FIXTURE, ...BASE, '--record', '--output', out], { engine, recordDir });
    const ledger = join(recordDir, 'eval-results.jsonl');
    expect(existsSync(ledger)).toBe(true);
    const records = readRows(ledger);
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.schema_version).toBe(3);
    expect(rec.suite).toBe('longmemeval');
    expect(rec.mode).toBe('balanced');
    expect(rec.status).toBe('completed');
    expect(rec.error).toBeUndefined();
    expect(typeof rec.duration_ms).toBe('number');
    expect(rec.params.retrieval_config_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.params.topK).toBe(5);
    expect(rec.params.questions_run).toBe(3);
    expect(rec.params.aggregate.total).toBe(2);
    expect(rec.params.output).toBe(out);
  }, 60_000);

  test('a failed gate records status failed with a redacted error', async () => {
    const recordDir = join(tmp, 'ledger-failed');
    const out = join(tmp, 'record-failed.jsonl');
    const code = await runCapturingExit([FIXTURE, ...BASE, '--record', '--by-type-floor', '0.99', '--output', out], { engine, recordDir });
    expect(code).toBe(1);
    const rec = readRows(join(recordDir, 'eval-results.jsonl'))[0];
    expect(rec.status).toBe('failed');
    expect(rec.error).toContain('exit 1');
  }, 60_000);

  test('redactSecrets scrubs DB connection strings, bearer tokens and provider keys (TODOS 1914)', () => {
    const raw = 'connect failed: postgres://brain_user:s3cr3t-pw@db.example.internal:5432/brain?sslmode=require; ' +
      'Authorization: Bearer abcdefghijklmnop.qrstuv; openai key sk-proj-abcdefghijklmnopqrstuvwxyz0123; ' +
      'anthropic sk-ant-api03-ABCDEFGHIJKLMNOP; voyage pa-ABCDEFGHIJKLMNOPQRST; api_key=zzzzzzzzzz&password=hunter2 stage=rerank';
    const red = redactSecrets(raw);
    expect(red).not.toContain('s3cr3t-pw');
    expect(red).not.toContain('brain_user:');
    expect(red).not.toContain('abcdefghijklmnop.qrstuv');
    expect(red).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123');
    expect(red).not.toContain('ABCDEFGHIJKLMNOP');
    expect(red).not.toContain('zzzzzzzzzz');
    expect(red).not.toContain('hunter2');
    // The diagnostic shape survives.
    expect(red).toContain('connect failed: postgres://<redacted>@db.example.internal:5432/brain');
    expect(red).toContain('Bearer <redacted>');
    expect(red).toContain('sk-<redacted>');
    expect(red).toContain('sk-ant-<redacted>');
    expect(red).toContain('stage=rerank');
    // Plain text is untouched.
    expect(redactSecrets('gateway boom: provider unavailable')).toBe('gateway boom: provider unavailable');
  });
});
