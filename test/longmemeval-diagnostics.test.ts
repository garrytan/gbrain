/**
 * Ranker wave Phase B1 — miss diagnostics (src/eval/longmemeval/diagnostics.ts).
 *
 * Pure pins: the class decision table (synthetic arm ranks → class), the frozen
 * clause splitter (fires on the four patterns; refuses single-clause, quoted
 * and Capitalized-Bigram connectors, short clauses; never more than 2), the H1
 * signature, the H3a/H3b split, receipt parsing + top-k reading, split
 * membership, the summary and the markdown glossary header.
 *
 * Hermetic e2e: the mixed-case fixture, a deterministic bag-of-words embed
 * transport through the gateway seam (no network, no key spend), one in-memory
 * PGLite. (1) A keyword-only-shaped receipt names mc-2 a strict miss at k=2 —
 * the row must locate the missing gold in the vector arm (rank 2), report the
 * keyword arm absent, and classify it `rerun_hit` (under hybrid pins the miss
 * does not reproduce — the class that keeps a receipt honest about its pins).
 * (2) The mc-2 haystack padded with first-clause decoys turns the same gold
 * into a genuine class (ii) miss with the H1 signature, and the frozen splitter's
 * clause probes support H1 with the embed cache bypassed.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyMiss,
  computeInnerLimit,
  contentTokens,
  emptyRanks,
  errorRow,
  glossFor,
  h1Signature,
  h3Candidates,
  parseReceipt,
  pinsFromReceipt,
  receiptTopKSessions,
  renderDiagnosticsMarkdown,
  runDiagnostics,
  sessionDistinctRanks,
  sessionRowRanks,
  splitClauses,
  splitClausesDetailed,
  splitMembership,
  summarizeDiagnostics,
  type ArmRanks,
  type MissDiagnosticsRow,
} from '../src/eval/longmemeval/diagnostics.ts';
import { buildSlugToRawMap } from '../src/eval/longmemeval/metrics.ts';
import { buildRunConfig, type RetrievalPins } from '../src/eval/longmemeval/run-config.ts';
import type { LongMemEvalQuestion } from '../src/eval/longmemeval/adapter.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { fnv1a } from '../src/eval/deterministic-embed.ts';
import { PRE_FUSION_POOL_FLOOR } from '../src/core/search/hybrid.ts';
import { MAX_SEARCH_LIMIT } from '../src/core/engine.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'longmemeval-mixedcase.jsonl');

function ranks(over: Partial<ArmRanks>): ArmRanks {
  return { ...emptyRanks(), ...over };
}

const BASE = { k: 5, gold_total: 2, reranker_ran: false, in_receipt_top_k: false, in_haystack: true };

describe('classifyMiss — the frozen B1 decision table', () => {
  test('(iv) ceiling wins whenever the question carries more gold sessions than k', () => {
    expect(classifyMiss({ ...BASE, gold_total: 6, ranks: ranks({ vector_rank: 1, fused_rank_rows: 1, final_rank_rows: 1 }) })).toBe('iv_ceiling');
  });
  test('(i) absent from every arm within depth', () => {
    expect(classifyMiss({ ...BASE, ranks: emptyRanks() })).toBe('i_absent_all_arms');
  });
  test('(ii) present in the vector pool but outside the fused top-k', () => {
    expect(classifyMiss({ ...BASE, ranks: ranks({ vector_rank: 37, fused_rank_rows: 12, fused_rank_sessions: 8 }) })).toBe('ii_in_pool_fused_out');
    // keyword-only / title-only presence is still "in a pool"
    expect(classifyMiss({ ...BASE, ranks: ranks({ keyword_rank: 90 }) })).toBe('ii_in_pool_fused_out');
    expect(classifyMiss({ ...BASE, ranks: ranks({ title_rank: 3 }) })).toBe('ii_in_pool_fused_out');
  });
  test('(iii) inside the fused top-k pre-rerank, reranked out', () => {
    expect(classifyMiss({ ...BASE, reranker_ran: true, ranks: ranks({ vector_rank: 2, fused_rank_rows: 3, post_rerank_rank_rows: 9, final_rank_rows: 9 }) })).toBe('iii_reranked_out');
  });
  test('rerun_hit: the re-created run returns the gold inside the top-k', () => {
    expect(classifyMiss({ ...BASE, ranks: ranks({ vector_rank: 1, fused_rank_rows: 2, final_rank_rows: 2 }) })).toBe('rerun_hit');
  });
  test('autocut_dropped / post_fusion_dropped: survived rerank (or fusion) inside the top-k, trimmed afterwards', () => {
    expect(classifyMiss({ ...BASE, reranker_ran: true, ranks: ranks({ vector_rank: 1, fused_rank_rows: 2, post_rerank_rank_rows: 4, final_rank_rows: null }) })).toBe('autocut_dropped');
    expect(classifyMiss({ ...BASE, ranks: ranks({ vector_rank: 1, fused_rank_rows: 2, final_rank_rows: null }) })).toBe('post_fusion_dropped');
  });
  test('receipt hit and dataset defect short-circuit', () => {
    expect(classifyMiss({ ...BASE, in_receipt_top_k: true, ranks: emptyRanks() })).toBe('hit');
    expect(classifyMiss({ ...BASE, in_haystack: false, ranks: emptyRanks() })).toBe('gold_absent_from_haystack');
  });
});

describe('h1Signature / h3Candidates / computeInnerLimit', () => {
  test('H1: another gold at fused session rank 1-3 AND the missing gold at 6-15', () => {
    expect(h1Signature([2], 9)).toBe(true);
    expect(h1Signature([2], 5)).toBe(false);
    expect(h1Signature([2], 16)).toBe(false);
    expect(h1Signature([4], 9)).toBe(false);
    expect(h1Signature([null], 9)).toBe(false);
    expect(h1Signature([1], null)).toBe(false);
    expect(h1Signature([], 9)).toBe(false);
  });
  test('H3a = vector top-depth but beyond inner_limit; H3b = fused pool beyond reranker_top_n_in', () => {
    expect(h3Candidates({ vector_rank: 77, fused_rank_rows: null, inner_limit: 50, reranker_top_n_in: 25 })).toEqual({ h3a: true, h3b: false });
    expect(h3Candidates({ vector_rank: 12, fused_rank_rows: 31, inner_limit: 50, reranker_top_n_in: 25 })).toEqual({ h3a: false, h3b: true });
    expect(h3Candidates({ vector_rank: 50, fused_rank_rows: 25, inner_limit: 50, reranker_top_n_in: 25 })).toEqual({ h3a: false, h3b: false });
    expect(h3Candidates({ vector_rank: null, fused_rank_rows: null, inner_limit: 50, reranker_top_n_in: 25 })).toEqual({ h3a: false, h3b: false });
  });
  test('inner_limit mirrors hybrid.ts: max(2k, PRE_FUSION_POOL_FLOOR) capped at MAX_SEARCH_LIMIT', () => {
    expect(computeInnerLimit(5)).toBe(PRE_FUSION_POOL_FLOOR);
    expect(computeInnerLimit(50)).toBe(MAX_SEARCH_LIMIT);
    expect(computeInnerLimit(30)).toBe(60);
  });
});

describe('splitClauses — frozen pattern list + guardrails', () => {
  test('how many (days|weeks|months) between X and Y', () => {
    expect(splitClauses('How many weeks passed between my trip to the coast and my dentist appointment?')).toEqual(['my trip to the coast', 'my dentist appointment']);
    expect(splitClausesDetailed('How many months between adopting the rescue dog and starting the pottery class').pattern).toBe('how_many_between');
  });
  test('between X and Y with a temporal signal', () => {
    const r = splitClausesDetailed('When did I move apartments, between the marathon I ran and the wedding I attended?');
    expect(r.pattern).toBe('between');
    expect(r.clauses).toEqual(['the marathon I ran', 'the wedding I attended']);
  });
  test('first … or … / which came first', () => {
    expect(splitClauses('Did I first buy the road bike or join the climbing gym?')).toEqual(['buy the road bike', 'join the climbing gym']);
    const r = splitClausesDetailed('Which came first, my move to the new city or the marathon I ran?');
    expect(r.pattern).toBe('first_or');
    expect(r.clauses).toEqual(['my move to the new city', 'the marathon I ran']);
  });
  test('before/after with two verb phrases (before-or-after, how-long-after, generic)', () => {
    expect(splitClauses('Did I adopt the tabby cat before or after I started the pottery class?')).toEqual(['I adopt the tabby cat', 'I started the pottery class']);
    const c = splitClausesDetailed('How long after I started the pottery class did I adopt the tabby cat?');
    expect(c.pattern).toBe('before_after');
    expect(c.clauses).toEqual(['I started the pottery class', 'I adopt the tabby cat']);
    expect(splitClauses('Which restaurant did we visit after the jazz concert in the park?')).toEqual(['Which restaurant did we visit', 'the jazz concert in the park']);
  });
  test('refuses a single-clause question', () => {
    expect(splitClauses('What kayak brand did I decide to buy for the river trip?')).toEqual([]);
    expect(splitClausesDetailed('What kayak brand did I decide to buy for the river trip?').reason).toBe('no_pattern');
    // "first" without a second event: no connector → falls through → nothing fires
    expect(splitClauses('What was the first concert I attended after moving?')).toEqual([]);
  });
  test('never splits inside quotes', () => {
    // the only "and" is inside the quoted title → no connector
    expect(splitClauses('How many weeks between the "Rock and Roll" concert?')).toEqual([]);
    expect(splitClausesDetailed('How many weeks between the "Rock and Roll" concert?').reason).toBe('no_connector');
    // the quoted "and" is skipped; the next connector splits, quoted phrase intact
    expect(splitClauses('How many weeks between the "Rock and Roll" concert and the jazz festival I attended?')).toEqual(['the "Rock and Roll" concert', 'the jazz festival I attended']);
    // marker inside quotes does not count as a pattern
    expect(splitClauses('Did I finish reading "Between Two Rivers and Beyond" last week?')).toEqual([]);
  });
  test('never splits a Capitalized-Bigram span', () => {
    expect(splitClauses('How many months between my interview at Procter and Gamble and my first day at the office?')).toEqual(['my interview at Procter and Gamble', 'my first day at the office']);
    expect(splitClauses('How many months between Procter and Gamble?')).toEqual([]);
  });
  test('both clauses need ≥ 2 content tokens; never more than 2 clauses', () => {
    const r = splitClausesDetailed('How many days between the trip and the exam?');
    expect(r.clauses).toEqual([]);
    expect(r.reason).toBe('clause_too_short');
    // Two capitalized month names bridge the connector → Capitalized-Bigram refusal, not a split
    expect(splitClausesDetailed('How many days between January and March?')).toEqual({ clauses: [], pattern: 'how_many_between', reason: 'no_connector' });
    const three = splitClauses('How many days between my trip to the coast and my final exam and my birthday party?');
    expect(three).toHaveLength(2);
    expect(three).toEqual(['my trip to the coast', 'my final exam and my birthday party']);
    expect(contentTokens('my trip to the coast')).toEqual(['trip', 'coast']);
  });
});

describe('receipt parsing, top-k reading, split membership, summary, glossary', () => {
  const RECEIPT = [
    JSON.stringify({ question_id: 'q1', question_type: 'temporal-reasoning', recall_all_hit: false, retrieved: [
      { slug: 'chat/s-a', chunk_id: 1, session_id: 's_A', rank: 1 }, { slug: 'chat/s-a', chunk_id: 2, session_id: 's_A', rank: 2 },
      { slug: 'chat/s-c', chunk_id: 1, session_id: 's_C', rank: 3 }, { slug: 'chat/s-b', chunk_id: 1, session_id: 's_B', rank: 4 },
    ], retrieved_session_ids: ['s_A', 's_C', 's_B'] }),
    'not json',
    JSON.stringify({ question_id: 'q2', recall_all_hit: true, retrieved_session_ids: ['x', 'y'] }),
    // The harness writes pins FLAT on run_config with `topK` (run-config.ts:buildRunConfig).
    JSON.stringify({ kind: 'by_type_summary', k: 5, run_config: { mode: 'balanced', keyword_only: false, reranker: { enabled: true, model: 'voyage:rerank-2.5' }, autocut: true, expansion: false, expansion_variant_budget: null, embedder: 'voyage-3@1024', topK: 5, knobs_hash: 'abc' } }),
  ].join('\n');

  test('parseReceipt separates rows from the summary and skips corrupt lines; pins come from the flat run_config (topK → top_k)', () => {
    const parsed = parseReceipt(RECEIPT);
    expect(parsed.rows.map(r => r.question_id)).toEqual(['q1', 'q2']);
    expect(parsed.summary?.k).toBe(5);
    expect(pinsFromReceipt(parsed)).toEqual({ mode: 'balanced', reranker: { enabled: true, model: 'voyage:rerank-2.5' }, autocut: true, expansion: false, expansion_variant_budget: null, top_k: 5, embedder: 'voyage-3@1024' });
    expect(pinsFromReceipt(parseReceipt('{"question_id":"z"}'))).toEqual({});
    expect(pinsFromReceipt(parseReceipt('{"kind":"by_type_summary","k":5,"run_config":{"knobs_hash":"abc"}}'))).toEqual({});
  });
  test('pinsFromReceipt round-trips the real buildRunConfig output: a reranker-off receipt reads back reranker off', () => {
    const pins: RetrievalPins = {
      mode: 'tokenmax', keyword_only: false, reranker: { enabled: false, model: 'voyage:rerank-2.5' }, autocut: false,
      expansion: true, expansion_variant_budget: 3, embedder: 'voyage-3@1024', top_k: 10, trajectory: false,
    };
    const run_config = buildRunConfig({
      pins, retrieval_config_hash: 'h', dataset_sha256: 'd', dataset_questions: 1, knobs_hash: 'k', knobs_hash_version: 1, cache: null,
      cache_skipped: 'disabled', reranker_skipped_rows: 0, vector_degraded_rows: 0, expansion_failed_rows: 0, expansion_replay_miss: 0,
      expansion_replay: null, gold_missing_from_haystack: 0, slug_collisions: 0, excluded_abstention: 0, question_ids_file: null, errors: 0,
    });
    expect(run_config).not.toHaveProperty('pins');
    const parsed = parseReceipt(JSON.stringify({ kind: 'by_type_summary', k: 10, run_config }));
    expect(pinsFromReceipt(parsed)).toEqual({
      mode: 'tokenmax', reranker: { enabled: false, model: 'voyage:rerank-2.5' }, autocut: false, expansion: true,
      expansion_variant_budget: 3, top_k: 10, embedder: 'voyage-3@1024',
    });
  });
  test('pinsFromReceipt still accepts a legacy nested run_config.pins block', () => {
    const parsed = parseReceipt(JSON.stringify({ kind: 'by_type_summary', k: 5, run_config: { pins: { mode: 'conservative', reranker: { enabled: false, model: 'x' }, autocut: true, expansion_variant_budget: null, top_k: 5 } } }));
    expect(pinsFromReceipt(parsed)).toEqual({ mode: 'conservative', reranker: { enabled: false, model: 'x' }, autocut: true, expansion_variant_budget: null, top_k: 5 });
  });
  test('receiptTopKSessions reads the distinct sessions among the top-k CHUNK rows (falls back to retrieved_session_ids)', () => {
    const parsed = parseReceipt(RECEIPT);
    expect(receiptTopKSessions(parsed.rows[0], 3)).toEqual(['s_A', 's_C']);
    expect(receiptTopKSessions(parsed.rows[0], 4)).toEqual(['s_A', 's_C', 's_B']);
    expect(receiptTopKSessions(parsed.rows[1], 1)).toEqual(['x']);
  });
  test('splitMembership tags every list containing the id; missing file → no tags', () => {
    const splits = { dev40: ['a'], decision430: ['b', 'c'], halfA430: ['b'], halfB430: ['c'], other: ['a'] };
    expect(splitMembership('a', splits)).toEqual(['dev40']);
    expect(splitMembership('b', splits)).toEqual(['decision430', 'halfA430']);
    expect(splitMembership('c', splits)).toEqual(['decision430', 'halfB430']);
    expect(splitMembership('zzz', splits)).toEqual([]);
    expect(splitMembership('a', null)).toEqual([]);
  });
  test('session rank builders: first row rank vs distinct-session rank through the slug→raw map', () => {
    const q = { question_id: 'q', question_type: 't', question: '', answer: '', haystack_sessions: [[], [], []], haystack_session_ids: ['Sess_A', 'Sess_B', 'Sess_C'], answer_session_ids: [] } as unknown as LongMemEvalQuestion;
    const map = buildSlugToRawMap(q);
    const rows = [{ slug: 'chat/sess-a' }, { slug: 'chat/sess-a' }, { slug: 'chat/sess-c' }, { slug: 'chat/sess-b' }];
    expect([...sessionRowRanks(rows, map)]).toEqual([['Sess_A', 1], ['Sess_C', 3], ['Sess_B', 4]]);
    expect([...sessionDistinctRanks(rows, map)]).toEqual([['Sess_A', 1], ['Sess_C', 2], ['Sess_B', 3]]);
  });

  function syntheticRow(over: Partial<MissDiagnosticsRow>): MissDiagnosticsRow {
    return {
      kind: 'lme_miss_diagnostics', question_id: 'q', question: 'q?', question_type: 'temporal-reasoning', splits: [], k: 5,
      gold_total: 2, gold: ['g1', 'g2'], missing: ['g2'], receipt_recall_all_hit: false,
      golds: [
        { session_id: 'g1', in_haystack: true, in_receipt_top_k: true, ranks: ranks({ fused_rank_sessions: 1 }), class: 'hit', h3a: false, h3b: false },
        { session_id: 'g2', in_haystack: true, in_receipt_top_k: false, ranks: ranks({ vector_rank: 70, fused_rank_rows: 30, fused_rank_sessions: 9 }), class: 'ii_in_pool_fused_out', h3a: true, h3b: true },
      ],
      primary_class: 'ii_in_pool_fused_out', h1_signature: true,
      clause_split: { fired: true, pattern: 'between', reason: null, clauses: ['a b', 'c d'], probes: [{ clause: 'a b', top5_sessions: ['g2'], hits_missing: ['g2'] }], h1_supported: true },
      rerun: { fused_limit: 50, inner_limit: 50, reranker_top_n_in: 25, reranker_ran: false, vector_enabled: true, degraded: [], expansion_replayed: false, distinct_sessions_fused: 12 },
      ...over,
    };
  }

  test('summarizeDiagnostics counts questions by type×class, sessions by class, hypotheses and split membership', () => {
    const rows = [
      syntheticRow({ question_id: 'a', splits: ['decision430', 'halfA430'] }),
      syntheticRow({ question_id: 'b', question_type: 'multi-session', splits: ['dev40'], h1_signature: false, primary_class: 'i_absent_all_arms',
        golds: [{ session_id: 'g2', in_haystack: true, in_receipt_top_k: false, ranks: emptyRanks(), class: 'i_absent_all_arms', h3a: false, h3b: false }], gold: ['g2'], gold_total: 1,
        clause_split: { fired: false, pattern: null, reason: 'no_pattern', clauses: [], probes: [], h1_supported: false } }),
      syntheticRow({ question_id: 'c', missing: [], primary_class: 'hit', h1_signature: false, error: 'boom' }),
    ];
    const s = summarizeDiagnostics(rows, { k: 5, depth: 200, fusedLimit: 50, innerLimit: 50, rerankerTopNIn: 25, pins: { mode: 'balanced', reranker: false, autocut: false, expansion_variant_budget: null }, questionsScanned: 470 });
    expect(s.questions_scanned).toBe(470);
    expect(s.questions_diagnosed).toBe(3);
    expect(s.misses).toBe(2);
    expect(s.errors).toBe(1);
    expect(s.by_type_class).toEqual({ 'temporal-reasoning': { ii_in_pool_fused_out: 1, hit: 1 }, 'multi-session': { i_absent_all_arms: 1 } });
    expect(s.gold_sessions_by_class).toEqual({ ii_in_pool_fused_out: 1, i_absent_all_arms: 1 });
    expect(s.h1_signature_count).toBe(1);
    expect(s.splitter_fired).toBe(2);
    expect(s.splitter_supported).toBe(2);
    expect(s.h3a_count).toBe(1);
    expect(s.h3b_count).toBe(1);
    expect(s.split_membership).toEqual({ dev40: 1, decision430: 1, halfA430: 1, halfB430: 0, halfA470: 0, halfB470: 0, unsplit: 0 });
    const md = renderDiagnosticsMarkdown(rows, s);
    expect(md).toContain('# LongMemEval miss diagnostics (Phase B1)');
    expect(md).toContain('**recall_all@k**');
    for (const name of ['vector_rank', 'keyword_rank', 'fused_rank', 'post_rerank_rank', 'class', 'h1_signature', 'splitter_fired', 'h1_supported', 'h3a', 'h3b', 'split_membership']) {
      expect(md).toContain(`**${name}** — `);
      expect(glossFor(name)).not.toBe('(no gloss)');
    }
    expect(md).toContain('| temporal-reasoning |');
    expect(md).toContain('| a | temporal-reasoning | decision430, halfA430 |');
    expect(md).toContain('error: boom');
  });
  test('error text is secret-redacted on the receipt row AND in the markdown table', () => {
    const q = { question_id: 'q', question_type: 't', question: 'q?', answer: '', haystack_sessions: [[]], haystack_session_ids: ['Sess_A'], answer_session_ids: ['Sess_A'] } as unknown as LongMemEvalQuestion;
    const knobs = { reranker_top_n_in: 25 } as unknown as Parameters<typeof errorRow>[6];
    const err = new Error('embed failed: postgres://user:hunter2@db.internal/brain api_key=sk-abcdefghijklmnop');
    const row = errorRow(q, { question_id: 'q', retrieved_session_ids: [] } as never, 5, null, 50, 50, knobs, err);
    expect(row.error).toContain('embed failed');
    expect(row.error).not.toContain('hunter2');
    expect(row.error).not.toContain('abcdefghijklmnop');
    expect(row.missing).toEqual(['Sess_A']);
    expect(row.primary_class).toBe('mixed');
    // A non-Error throw is stringified.
    expect(errorRow(q, { question_id: 'q' } as never, 5, null, 50, 50, knobs, 'plain string').error).toBe('plain string');
    // The markdown renderer redacts too (a receipt written before redaction landed is still safe to render).
    const rows = [syntheticRow({ question_id: 'e', error: 'token=sk-zyxwvutsrqponmlk boom' })];
    const s = summarizeDiagnostics(rows, { k: 5, depth: 200, fusedLimit: 50, innerLimit: 50, rerankerTopNIn: 25, pins: { mode: 'balanced', reranker: false, autocut: false, expansion_variant_budget: null }, questionsScanned: 1 });
    const md = renderDiagnosticsMarkdown(rows, s);
    expect(md).toContain('boom');
    expect(md).not.toContain('zyxwvutsrqponmlk');
  });
  test('glossFor reads the shared glossary for shared names and the local one otherwise', () => {
    expect(glossFor('recall_all@k')).toContain('gold session');
    expect(glossFor('h3a')).toContain('inner_limit');
    expect(glossFor('nope')).toBe('(no gloss)');
  });
});

// ---------------------------------------------------------------------------
// Hermetic e2e on the mixed-case fixture
// ---------------------------------------------------------------------------

/** Deterministic bag-of-words embedding (1536-d, the default schema). */
function fakeVec(text: string): number[] {
  const v = new Array<number>(1536).fill(0);
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) v[fnv1a(tok) % 1536] += 1;
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map(x => x / n);
}

describe('e2e — mixed-case fixture, stub embed transport, synthetic receipt', () => {
  let engine: PGLiteEngine;
  let tmp: string;
  const transport = { calls: 0 };
  const fakeTransport = (async (params: { values: string[] }) => {
    transport.calls++;
    return { embeddings: params.values.map(fakeVec), values: params.values, warnings: [], usage: { tokens: params.values.length } };
  }) as any;

  beforeAll(async () => {
    engine = await createBenchmarkBrain();
    tmp = mkdtempSync(join(tmpdir(), 'lme-diag-'));
  });
  afterAll(async () => {
    if (engine) await engine.disconnect();
    rmSync(tmp, { recursive: true, force: true });
  });
  afterEach(() => {
    __setEmbedTransportForTests(null);
    resetGateway();
  });

  test('mc-2 strict miss at k=2 → missing gold at vector rank 2, keyword absent, class rerun_hit under hybrid pins; cache stats reported', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
    __setEmbedTransportForTests(fakeTransport);
    const questions = readFileSync(FIXTURE, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as LongMemEvalQuestion);
    // A keyword-only-shaped receipt at top_k=2: strict AND matched one chunk row (Sess_MULTI_a),
    // so the distinct sessions in the top-2 rows are [Sess_MULTI_a] and Sess_MULTI_b is the strict miss.
    const receipt = parseReceipt([
      JSON.stringify({ question_id: 'mc-1', question_type: 'single-session-user', recall_all_hit: true, recall_any_hit: true,
        retrieved: [{ slug: 'chat/sharegpt-yywfirx-0', chunk_id: 1, session_id: 'sharegpt_yywfIrx_0', rank: 1, score: 1 }], retrieved_session_ids: ['sharegpt_yywfIrx_0'] }),
      JSON.stringify({ question_id: 'mc-2', question_type: 'multi-session', recall_all_hit: false, recall_any_hit: true,
        retrieved: [{ slug: 'chat/sess-multi-a', chunk_id: 1, session_id: 'Sess_MULTI_a', rank: 1, score: 1 }], retrieved_session_ids: ['Sess_MULTI_a'] }),
      JSON.stringify({ question_id: 'mc-3_abs', question_type: 'single-session-assistant', recall_all_hit: false, abstention: true, retrieved: [], retrieved_session_ids: [] }),
      JSON.stringify({ kind: 'by_type_summary', k: 2, run_config: { mode: 'balanced', reranker: { enabled: false, model: 'x' }, autocut: false, expansion_variant_budget: null, topK: 2 } }),
    ].join('\n'));
    const cachePath = join(tmp, 'embed-cache.sqlite');
    const splits = { dev40: ['mc-9'], decision430: ['mc-2'], halfA430: ['mc-2'], halfB430: ['mc-1'] };

    const result = await runDiagnostics({
      engine, receipt, questions, splits,
      pins: { mode: 'balanced', reranker: false, autocut: false, expansionVariantBudget: null },
      embedCachePath: cachePath, embedTransport: fakeTransport,
    });

    // Only the strict miss is diagnosed (abstention + hits are skipped without --all); k came from the receipt.
    expect(result.rows.map(r => r.question_id)).toEqual(['mc-2']);
    const row = result.rows[0];
    expect(row.error).toBeUndefined();
    expect(row.k).toBe(2);
    expect(row.gold).toEqual(['Sess_MULTI_a', 'Sess_MULTI_b']);
    expect(row.missing).toEqual(['Sess_MULTI_b']);
    expect(row.splits).toEqual(['decision430', 'halfA430']);
    expect(row.rerun.vector_enabled).toBe(true);
    expect(row.rerun.reranker_ran).toBe(false);
    expect(row.rerun.inner_limit).toBe(PRE_FUSION_POOL_FLOOR);
    expect(row.rerun.reranker_top_n_in).toBe(25); // balanced bundle
    expect(row.rerun.distinct_sessions_fused).toBe(3);

    const b = row.golds.find(g => g.session_id === 'Sess_MULTI_b')!;
    // Vector arm: the bag-of-words vector shares tokens with the question → second-best session.
    expect(b.ranks.vector_rank).toBe(2);
    // Keyword arm: strict AND websearch has no "sourdough"/"loaves" in Sess_MULTI_b, and the
    // strict arm returned rows so the OR fallback never fired → absent.
    expect(b.ranks.keyword_rank).toBeNull();
    expect(b.ranks.keyword_relaxed).toBe(false);
    expect(b.ranks.title_rank).toBeNull();
    // Fused: rank 2 in the limit-50 call → inside the top-2 the receipt scored → the miss does NOT
    // reproduce under hybrid pins (the receipt was keyword-only) → rerun_hit, never (i)-(iv).
    expect(b.ranks.fused_rank_rows).toBe(2);
    expect(b.ranks.fused_rank_sessions).toBe(2);
    expect(b.ranks.post_rerank_rank_rows).toBeNull();
    expect(b.ranks.final_rank_rows).toBe(2);
    expect(b.class).toBe('rerun_hit');
    expect(b.h3a).toBe(false);
    expect(b.h3b).toBe(false);
    expect(row.primary_class).toBe('rerun_hit');
    expect(row.h1_signature).toBe(false);
    // The found gold is reported too, classed as a receipt hit, with its own arm ranks.
    const a = row.golds.find(g => g.session_id === 'Sess_MULTI_a')!;
    expect(a.class).toBe('hit');
    expect(a.ranks).toMatchObject({ vector_rank: 1, keyword_rank: 1, fused_rank_rows: 1, fused_rank_sessions: 1, final_rank_rows: 1 });
    // Single-clause question → splitter did not fire, no probes ran.
    expect(row.clause_split.fired).toBe(false);
    expect(row.clause_split.probes).toEqual([]);

    // Summary + cache receipt (3 pages + the question = 4 misses on a cold cache; hybridSearch's
    // own embed of the same question text is the 1 hit).
    const s = result.summary;
    expect(s.misses).toBe(1);
    expect(s.rerun_hit_count).toBe(1);
    expect(s.questions_scanned).toBe(3);
    expect(s.by_type_class).toEqual({ 'multi-session': { rerun_hit: 1 } });
    expect(s.gold_sessions_by_class).toEqual({ rerun_hit: 1 });
    expect(s.split_membership.halfA430).toBe(1);
    expect(s.split_membership.halfB430).toBe(0);
    expect(s.pins).toEqual({ mode: 'balanced', reranker: false, autocut: false, expansion_variant_budget: null });
    expect(s.cache).toEqual({ path: cachePath, hits: 1, misses: 4, bypassed: 0, infra_faults: 0 });
    expect(transport.calls).toBeGreaterThan(0);

    // Markdown renders the itemization for the miss.
    const md = renderDiagnosticsMarkdown(result.rows, s);
    expect(md).toContain('| mc-2 | multi-session | decision430, halfA430 | Sess_MULTI_a, Sess_MULTI_b | Sess_MULTI_b |');
    expect(md).toContain('Sess_MULTI_b*: 2/—/—/2;2/—/2 [rerun_hit]');

    // Second pass: every page + question embed is now a cache hit (like-for-like vectors, D9).
    const again = await runDiagnostics({
      engine, receipt, questions, splits,
      pins: { mode: 'balanced', reranker: false, autocut: false, expansionVariantBudget: null },
      embedCachePath: cachePath, embedTransport: fakeTransport,
    });
    expect(again.summary.cache).toEqual({ path: cachePath, hits: 5, misses: 0, bypassed: 0, infra_faults: 0 });
    expect(again.rows[0].golds.find(g => g.session_id === 'Sess_MULTI_b')!.ranks).toEqual(b.ranks);
  }, 120_000);

  test('--all diagnoses hits too; a decoy-padded two-event miss lands class (ii) with the H1 signature, and the clause probes support H1 with the cache bypassed', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
    __setEmbedTransportForTests(fakeTransport);
    const base = readFileSync(FIXTURE, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as LongMemEvalQuestion);
    const mc2 = base.find(q => q.question_id === 'mc-2')!;
    // Pad mc-2's haystack: the sourdough gold is rewritten to echo the first clause, eight decoys echo it a
    // little less, and the rye gold (Sess_MULTI_b, fixture text verbatim) only echoes the second clause — so
    // under the bag-of-words embedding the fused order is [gold A, 8 decoys, gold B]: B sits at session rank
    // 10 (6-15), A at rank 1 (1-3), B outside the top-5 but inside the pool → class (ii) + H1 signature.
    // No page carries every question term, so the keyword arm's AND→OR fallback fires (relaxed rows, which
    // hybrid drops pre-fusion while the vector arm is healthy) — the row records that too.
    const question = 'How many weeks between the twelve sourdough loaves alice-example planned for the bake sale and the rye starter tips?';
    const decoyWords = ['poster', 'banner', 'flyer', 'table', 'jar', 'sign', 'ribbon', 'basket'];
    const sessions: Array<Array<{ role: 'user' | 'assistant'; content: string }>> = [
      [{ role: 'user', content: 'alice-example planned twelve sourdough loaves for the bake sale.' },
       { role: 'assistant', content: 'Twelve sourdough loaves for the bake sale: how many hours of proofing?' }],
      ...decoyWords.map(w => [
        { role: 'user' as const, content: `alice-example planned a bake sale ${w}.` },
        { role: 'assistant' as const, content: `Twelve ${w}s for the bake sale is plenty; the loaves can wait.` },
      ]),
      (mc2.haystack_sessions as Array<Array<{ role: 'user' | 'assistant'; content: string }>>)[1], // Sess_MULTI_b verbatim
    ];
    const ids = ['Sess_MULTI_a', ...decoyWords.map(w => `Decoy_${w}`), 'Sess_MULTI_b'];
    const padded: LongMemEvalQuestion = {
      ...mc2, question_id: 'mc-2-padded', question_type: 'temporal-reasoning', question,
      haystack_sessions: sessions, haystack_session_ids: ids, haystack_dates: ids.map((_, i) => `2025-05-${String(i + 1).padStart(2, '0')}`),
      answer_session_ids: ['Sess_MULTI_a', 'Sess_MULTI_b'],
    };
    const questions = [...base, padded];
    const receipt = parseReceipt([
      JSON.stringify({ question_id: 'mc-1', question_type: 'single-session-user', recall_all_hit: true, retrieved_session_ids: ['sharegpt_yywfIrx_0'] }),
      JSON.stringify({ question_id: 'mc-2-padded', question_type: 'temporal-reasoning', recall_all_hit: false,
        retrieved_session_ids: ['Sess_MULTI_a', 'Decoy_poster', 'Decoy_banner', 'Decoy_flyer', 'Decoy_table'] }),
    ].join('\n'));
    const cachePath = join(tmp, 'embed-cache-all.sqlite');
    const before = transport.calls;
    const result = await runDiagnostics({
      engine, receipt, questions, splits: null, k: 5, all: true,
      pins: { mode: 'balanced', reranker: false, autocut: false },
      embedCachePath: cachePath, embedTransport: fakeTransport,
    });
    expect(result.rows.map(r => r.question_id)).toEqual(['mc-1', 'mc-2-padded']);
    const hit = result.rows[0];
    expect(hit.missing).toEqual([]);
    expect(hit.primary_class).toBe('hit');
    expect(hit.golds[0].class).toBe('hit');
    expect(hit.clause_split.fired).toBe(false);

    const miss = result.rows[1];
    expect(miss.error).toBeUndefined();
    expect(miss.missing).toEqual(['Sess_MULTI_b']);
    expect(miss.rerun.distinct_sessions_fused).toBe(10);
    const a = miss.golds.find(g => g.session_id === 'Sess_MULTI_a')!;
    const b = miss.golds.find(g => g.session_id === 'Sess_MULTI_b')!;
    expect(a.class).toBe('hit');
    expect(a.ranks.fused_rank_sessions).toBeLessThanOrEqual(3);
    expect(a.ranks.keyword_relaxed).toBe(true);
    // B: found in the vector arm within depth (rank 10 of 10 sessions, one chunk each), outside the
    // pre-rerank fused top-5 → class (ii). Keyword presence is relaxed-only (OR fallback).
    expect(b.ranks.vector_rank).toBe(10);
    expect(b.ranks.keyword_rank).not.toBeNull();
    expect(b.ranks.keyword_relaxed).toBe(true);
    expect(b.ranks.fused_rank_rows).toBe(10);
    expect(b.ranks.fused_rank_sessions).toBe(10);
    expect(b.ranks.post_rerank_rank_rows).toBeNull();
    expect(b.ranks.final_rank_rows).toBe(10);
    expect(b.class).toBe('ii_in_pool_fused_out');
    // Inside the pre-fusion pool and the reranker window → neither H3 branch.
    expect(b.h3a).toBe(false);
    expect(b.h3b).toBe(false);
    expect(miss.primary_class).toBe('ii_in_pool_fused_out');
    // H1 signature: A at 1-3, B at 6-15.
    expect(miss.h1_signature).toBe(true);
    // Frozen splitter fired on `how many weeks between X and Y`; the rye clause's own vector top-5 holds B.
    expect(miss.clause_split.fired).toBe(true);
    expect(miss.clause_split.pattern).toBe('how_many_between');
    expect(miss.clause_split.clauses).toEqual(['the twelve sourdough loaves alice-example planned for the bake sale', 'the rye starter tips']);
    expect(miss.clause_split.probes).toHaveLength(2);
    expect(miss.clause_split.probes[0].top5_sessions[0]).toBe('Sess_MULTI_a');
    expect(miss.clause_split.probes[0].hits_missing).toEqual([]);
    expect(miss.clause_split.probes[1].top5_sessions[0]).toBe('Sess_MULTI_b');
    expect(miss.clause_split.probes[1].hits_missing).toEqual(['Sess_MULTI_b']);
    expect(miss.clause_split.h1_supported).toBe(true);
    expect(result.summary.h1_signature_count).toBe(1);
    expect(result.summary.splitter_fired).toBe(1);
    expect(result.summary.splitter_supported).toBe(1);
    expect(result.summary.by_type_class).toEqual({ 'single-session-user': { hit: 1 }, 'temporal-reasoning': { ii_in_pool_fused_out: 1 } });
    // Clause embeds went to the transport directly (cache bypassed) — never written to the shared cache...
    expect(transport.calls).toBeGreaterThan(before);
    const { EmbeddingCache } = await import('../src/eval/shared/embed-cache.ts');
    const c = new EmbeddingCache(cachePath);
    c.open();
    for (const clause of miss.clause_split.clauses) expect(c.get('openai:text-embedding-3-large', 1536, clause)).toBeNull();
    // ...while the question itself was cached through the harness seam.
    expect(c.get('openai:text-embedding-3-large', 1536, question)).not.toBeNull();
    c.close();
    // The markdown itemization carries the hypotheses column.
    const md = renderDiagnosticsMarkdown(result.rows, result.summary);
    expect(md).toContain('| mc-2-padded | temporal-reasoning | — | Sess_MULTI_a, Sess_MULTI_b | Sess_MULTI_b |');
    expect(md).toContain('H1sig, split(how_many_between), H1sup');
  }, 120_000);
});
