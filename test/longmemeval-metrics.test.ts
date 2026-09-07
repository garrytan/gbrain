/**
 * Pure tests for src/eval/longmemeval/metrics.ts — no PGLite, no LLM, no
 * network. Pins the raw-id join, recall_all@k / recall_any@k semantics, the
 * bucket + schema-v2 summary shape, and the per-question row assembler.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { SearchResult } from '../src/core/types.ts';
import {
  haystackToPages,
  sanitizeSessionIdForSlug,
  type LongMemEvalQuestion,
} from '../src/eval/longmemeval/adapter.ts';
import {
  normalizeSessionId,
  sessionIdFromSlug,
  isAbstentionQuestion,
  buildSlugToRawMap,
  detectSlugCollisions,
  collisionsTouchingGold,
  goldMissingFromHaystack,
  distinctRetrievedSessions,
  scoreRecall,
  newBucket,
  addRowToBucket,
  buildByTypeSummaryV2,
  buildRow,
  rawSessionId,
  type RecallBucket,
} from '../src/eval/longmemeval/metrics.ts';
import { rawSessionId as readerRawSessionId } from '../src/eval/longmemeval/reader.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'longmemeval-mixedcase.jsonl');

function row(slug: string, opts: Partial<SearchResult> = {}): SearchResult {
  return {
    slug,
    page_id: 1,
    title: slug,
    type: 'note',
    chunk_text: 'x',
    chunk_source: 'compiled_truth',
    chunk_id: opts.chunk_id ?? 0,
    chunk_index: 0,
    score: opts.score ?? 0.5,
    stale: false,
    ...opts,
  } as SearchResult;
}

function sQuestion(
  id: string,
  ids: string[],
  gold: string[],
  overrides: Partial<LongMemEvalQuestion> = {},
): LongMemEvalQuestion {
  return {
    question_id: id,
    question_type: 'single-session-user',
    question: 'q?',
    answer: 'a',
    haystack_session_ids: ids,
    haystack_sessions: ids.map((sid, i) => [{ role: 'user' as const, content: `placeholder turn ${i} for ${sid}` }]),
    answer_session_ids: gold,
    ...overrides,
  };
}

describe('normalizeSessionId / sessionIdFromSlug / isAbstentionQuestion', () => {
  test('normalizeSessionId is the adapter sanitizer', () => {
    expect(normalizeSessionId).toBe(sanitizeSessionIdForSlug);
  });

  test('uppercase, underscore, dot and unicode all normalize consistently', () => {
    expect(normalizeSessionId('sharegpt_yywfIrx_0')).toBe('sharegpt-yywfirx-0');
    expect(normalizeSessionId('Sess.MULTI_a')).toBe('sess-multi-a');
    expect(normalizeSessionId('sessé_1')).toBe('sess--1');
    expect(normalizeSessionId('A_B')).toBe(normalizeSessionId('a-b'));
    // Idempotent: normalizing a normalized id is a no-op.
    const once = normalizeSessionId('sharegpt_yywfIrx_0');
    expect(normalizeSessionId(once)).toBe(once);
  });

  test('normalized ids round-trip through the adapter slug', () => {
    const q = sQuestion('q1', ['sharegpt_yywfIrx_0'], []);
    const pages = haystackToPages(q);
    expect(pages[0].slug).toBe(`chat/${normalizeSessionId('sharegpt_yywfIrx_0')}`);
    expect(sessionIdFromSlug(pages[0].slug)).toBe('sharegpt-yywfirx-0');
  });

  test('sessionIdFromSlug strips chat/, then any first segment, else returns the slug', () => {
    expect(sessionIdFromSlug('chat/abc-1')).toBe('abc-1');
    expect(sessionIdFromSlug('chat/nested/abc')).toBe('nested/abc');
    expect(sessionIdFromSlug('other/abc')).toBe('abc');
    expect(sessionIdFromSlug('bare')).toBe('bare');
  });

  test('abstention detection is the _abs suffix only', () => {
    expect(isAbstentionQuestion('mc-3_abs')).toBe(true);
    expect(isAbstentionQuestion('gpt4_abs')).toBe(true);
    expect(isAbstentionQuestion('mc-3_absent')).toBe(false);
    expect(isAbstentionQuestion('abs_mc-3')).toBe(false);
    expect(isAbstentionQuestion('')).toBe(false);
  });
});

describe('rawSessionId — the ONE slug→raw resolver', () => {
  test('mapped slug → first raw id in haystack order; unmapped slug (or no map) → normalized tail; reader.ts re-exports the same function', () => {
    const map = buildSlugToRawMap(sQuestion('q', ['Sess_A', 'sess-a', 'Other_1'], []));
    expect(rawSessionId('chat/sess-a', map)).toBe('Sess_A');
    expect(rawSessionId('chat/other-1', map)).toBe('Other_1');
    expect(rawSessionId('chat/unmapped-9', map)).toBe('unmapped-9');
    expect(rawSessionId('chat/unmapped-9')).toBe('unmapped-9');
    expect(rawSessionId('notes/x')).toBe('x');
    expect(readerRawSessionId).toBe(rawSessionId);
  });
});

describe('buildSlugToRawMap / detectSlugCollisions', () => {
  test('maps every adapter slug back to its raw id (mixed-case _s shape)', () => {
    const q = sQuestion('q1', ['sharegpt_yywfIrx_0', 'sharegpt_AbC_1', 'sharegpt_Qz.9_2'], ['sharegpt_yywfIrx_0']);
    const map = buildSlugToRawMap(q);
    const slugs = haystackToPages(q).map(p => p.slug);
    expect(Array.from(map.keys()).sort()).toEqual([...slugs].sort());
    expect(map.get('chat/sharegpt-yywfirx-0')).toEqual(['sharegpt_yywfIrx_0']);
    expect(map.get('chat/sharegpt-qz-9-2')).toEqual(['sharegpt_Qz.9_2']);
    expect(detectSlugCollisions(map)).toEqual([]);
  });

  test('oracle shape ({session_id, turns}) is accepted too', () => {
    const q: LongMemEvalQuestion = {
      question_id: 'q-oracle',
      question_type: 'multi-session',
      question: 'q?',
      answer: 'a',
      answer_session_ids: ['S_1'],
      haystack_sessions: [
        { session_id: 'S_1', turns: [{ role: 'user', content: 'a' }] },
        { session_id: 's-2', turns: [{ role: 'user', content: 'b' }] },
      ],
    };
    const map = buildSlugToRawMap(q);
    expect(map.get('chat/s-1')).toEqual(['S_1']);
    expect(map.get('chat/s-2')).toEqual(['s-2']);
  });

  test('a_b vs a-b collide on the slug and are reported once, sorted', () => {
    const q = sQuestion('q1', ['z_z', 'a_b', 'a-b', 'other', 'z-z'], ['a_b']);
    const map = buildSlugToRawMap(q);
    expect(map.get('chat/a-b')).toEqual(['a_b', 'a-b']);
    expect(detectSlugCollisions(map)).toEqual(['chat/a-b', 'chat/z-z']);
    expect(collisionsTouchingGold(map, ['a_b'])).toEqual(['chat/a-b']);
    expect(collisionsTouchingGold(map, ['other'])).toEqual([]);
  });

  test('an identical raw id repeated in the haystack is deduped, not a collision', () => {
    const q = sQuestion('q1', ['dup_1', 'dup_1'], ['dup_1']);
    const map = buildSlugToRawMap(q);
    expect(map.get('chat/dup-1')).toEqual(['dup_1']);
    expect(detectSlugCollisions(map)).toEqual([]);
  });

  test('gold absent from the haystack is reported', () => {
    const q = sQuestion('q1', ['s_1', 's_2'], ['s_1', 'ghost_9', 'ghost_9']);
    const map = buildSlugToRawMap(q);
    expect(goldMissingFromHaystack(map, q.answer_session_ids)).toEqual(['ghost_9']);
    // Gold compare is on RAW ids: a normalized spelling of a present id is NOT present.
    expect(goldMissingFromHaystack(map, ['s-1'])).toEqual(['s-1']);
  });
});

describe('distinctRetrievedSessions', () => {
  const q = sQuestion('q1', ['Sess_MULTI_a', 'Sess_MULTI_b', 'Sess_DECOY_c'], ['Sess_MULTI_a', 'Sess_MULTI_b']);
  const map = buildSlugToRawMap(q);

  test('collapses chunk rows to raw ids in first-occurrence order with 1-based ranks', () => {
    const results = [
      row('chat/sess-decoy-c', { chunk_id: 1, score: 0.9 }),
      row('chat/sess-multi-a', { chunk_id: 2, score: 0.8, rerank_score: 0.7 }),
      row('chat/sess-decoy-c', { chunk_id: 3, score: 0.6 }),
      row('chat/sess-multi-a', { chunk_id: 4, score: 0.5 }),
    ];
    const distinct = distinctRetrievedSessions(results, map);
    expect(distinct).toEqual([
      { session_id: 'Sess_DECOY_c', rank: 1, score: 0.9 },
      { session_id: 'Sess_MULTI_a', rank: 2, score: 0.8, rerank_score: 0.7 },
    ]);
  });

  test('empty results yield an empty list; unmapped slugs fall back to the normalized tail', () => {
    expect(distinctRetrievedSessions([], map)).toEqual([]);
    expect(distinctRetrievedSessions([row('chat/unknown-9')], map)[0].session_id).toBe('unknown-9');
    expect(distinctRetrievedSessions([row('chat/sess-multi-b')])[0].session_id).toBe('sess-multi-b');
  });
});

describe('scoreRecall', () => {
  test('empty retrieved: both hits false, distinct 0, gold counted', () => {
    expect(scoreRecall([], ['g1', 'g2'], 5)).toEqual({
      recall_all_hit: false,
      recall_any_hit: false,
      gold_total: 2,
      gold_found: 0,
      distinct_sessions_in_top_k: 0,
    });
  });

  test('all gold present -> all=true any=true; partial -> all=false any=true; none -> both false', () => {
    expect(scoreRecall(['d', 'g1', 'g2'], ['g1', 'g2'], 5)).toMatchObject({ recall_all_hit: true, recall_any_hit: true, gold_found: 2 });
    expect(scoreRecall(['d', 'g1'], ['g1', 'g2'], 5)).toMatchObject({ recall_all_hit: false, recall_any_hit: true, gold_found: 1 });
    expect(scoreRecall(['d', 'e'], ['g1', 'g2'], 5)).toMatchObject({ recall_all_hit: false, recall_any_hit: false, gold_found: 0 });
  });

  test('raw-id join: normalized spelling does not match raw gold', () => {
    expect(scoreRecall(['sess-multi-a'], ['Sess_MULTI_a'], 5).recall_any_hit).toBe(false);
    expect(scoreRecall(['Sess_MULTI_a'], ['Sess_MULTI_a'], 5).recall_all_hit).toBe(true);
  });

  test('k larger than the rows scores what came back; duplicates in either list are collapsed', () => {
    const s = scoreRecall(['g1', 'g1', 'd'], ['g1', 'g1'], 50);
    expect(s).toEqual({ recall_all_hit: true, recall_any_hit: true, gold_total: 1, gold_found: 1, distinct_sessions_in_top_k: 2 });
  });

  test('k caps the distinct list defensively (caller is expected to pre-slice rows)', () => {
    const s = scoreRecall(['a', 'b', 'c', 'g'], ['g'], 3);
    expect(s.distinct_sessions_in_top_k).toBe(3);
    expect(s.recall_any_hit).toBe(false);
  });

  test('empty gold is NOT vacuously a hit', () => {
    const s = scoreRecall(['a'], [], 5);
    expect(s.recall_all_hit).toBe(false);
    expect(s.recall_any_hit).toBe(false);
    expect(s.gold_total).toBe(0);
  });

  test('six-gold question needs all six', () => {
    const gold = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'];
    expect(scoreRecall(gold.slice(0, 5), gold, 10)).toMatchObject({ recall_all_hit: false, recall_any_hit: true, gold_found: 5 });
    expect(scoreRecall(gold, gold, 10).recall_all_hit).toBe(true);
  });

  test('non-positive or fractional k is rejected', () => {
    expect(() => scoreRecall([], ['g'], 0)).toThrow(RangeError);
    expect(() => scoreRecall([], ['g'], 2.5)).toThrow(RangeError);
  });
});

describe('buckets + buildByTypeSummaryV2', () => {
  test('v2 rows count both metrics; legacy rows count any-only and bump legacy_rows; unscored rows skip', () => {
    const b = newBucket();
    expect(addRowToBucket(b, { recall_all_hit: true, recall_any_hit: true })).toBe('scored');
    expect(addRowToBucket(b, { recall_all_hit: false, recall_any_hit: true })).toBe('scored');
    expect(addRowToBucket(b, { recall_hit: true })).toBe('legacy');
    expect(addRowToBucket(b, { recall_hit: false })).toBe('legacy');
    expect(addRowToBucket(b, {})).toBe('skipped');
    expect(addRowToBucket(b, { recall_hit: 'yes' })).toBe('skipped');
    expect(b).toEqual({ total: 4, any_hit: 3, all_hit: 1, legacy_rows: 2 });
  });

  test('populated buckets: sorted keys, both rates, aggregate sums, context fields', () => {
    const buckets: Record<string, RecallBucket> = {
      'single-session-user': { total: 19, any_hit: 19, all_hit: 18, legacy_rows: 0 },
      'multi-session': { total: 10, any_hit: 10, all_hit: 6, legacy_rows: 0 },
    };
    const summary = buildByTypeSummaryV2(buckets, {
      k: 5,
      excludedAbstention: 3,
      goldMissingFromHaystack: 1,
      slugCollisions: 2,
      runConfig: { mode: 'balanced', reranker: 'off' },
      distinctSessionsInTopK: [5, 5, 4, 5, 3],
    });
    expect(summary.schema_version).toBe(2);
    expect(summary.kind).toBe('by_type_summary');
    expect(summary.metric).toBe('recall_all@k');
    expect(summary.k).toBe(5);
    expect(summary.excluded_abstention).toBe(3);
    expect(Object.keys(summary.recall_by_type)).toEqual(['multi-session', 'single-session-user']);
    expect(summary.recall_by_type['multi-session']).toEqual({ total: 10, all_hit: 6, all_rate: 0.6, any_hit: 10, any_rate: 1 });
    expect(summary.recall_by_type['single-session-user'].all_rate).toBeCloseTo(18 / 19, 6);
    expect(summary.aggregate).toEqual({ total: 29, all_hit: 24, all_rate: 24 / 29, any_hit: 29, any_rate: 1 });
    expect(summary.legacy_rows).toBe(0);
    expect(summary.gold_missing_from_haystack).toBe(1);
    expect(summary.slug_collisions).toBe(2);
    expect(summary.mean_distinct_sessions).toBeCloseTo(4.4, 9);
    expect(summary.run_config).toEqual({ mode: 'balanced', reranker: 'off' });
    expect(summary.qa_accuracy).toBeUndefined();
  });

  test('empty buckets: null rates (never NaN), no mean, legacy_rows 0', () => {
    const summary = buildByTypeSummaryV2({}, {
      k: 5, excludedAbstention: 0, goldMissingFromHaystack: 0, slugCollisions: 0, runConfig: {},
    });
    expect(summary.recall_by_type).toEqual({});
    expect(summary.aggregate).toEqual({ total: 0, all_hit: 0, all_rate: null, any_hit: 0, any_rate: null });
    expect('mean_distinct_sessions' in summary).toBe(false);
    expect(summary.legacy_rows).toBe(0);
    // An empty per-type bucket (possible after skipped rows) also gets null rates.
    const withEmpty = buildByTypeSummaryV2({ t: newBucket() }, {
      k: 5, excludedAbstention: 0, goldMissingFromHaystack: 0, slugCollisions: 0, runConfig: {},
    });
    expect(withEmpty.recall_by_type.t).toEqual({ total: 0, all_hit: 0, all_rate: null, any_hit: 0, any_rate: null });
  });

  test('legacy rows surface in the summary and qa_accuracy passes through', () => {
    const b = newBucket();
    addRowToBucket(b, { recall_hit: true });
    addRowToBucket(b, { recall_all_hit: true, recall_any_hit: true });
    const qa = { judged: 2, correct: 1, accuracy: 0.5, judge_errors: 0 };
    const summary = buildByTypeSummaryV2({ t: b }, {
      k: 5, excludedAbstention: 0, goldMissingFromHaystack: 0, slugCollisions: 0, runConfig: {}, qa,
    });
    expect(summary.legacy_rows).toBe(1);
    expect(summary.recall_by_type.t).toEqual({ total: 2, all_hit: 1, all_rate: 0.5, any_hit: 2, any_rate: 1 });
    expect(summary.qa_accuracy).toEqual(qa);
  });
});

describe('buildRow', () => {
  const q = sQuestion('mc-2', ['Sess_MULTI_a', 'Sess_MULTI_b', 'Sess_DECOY_c'], ['Sess_MULTI_a', 'Sess_MULTI_b'], {
    question_type: 'multi-session',
    question: 'sourdough loaves',
    answer: 'twelve',
  });
  const map = buildSlugToRawMap(q);

  test('scores recall over the top-k distinct sessions but records every returned row', () => {
    const results = [
      row('chat/sess-multi-a', { chunk_id: 11, score: 0.9, rerank_score: 0.8, alias_hit: true }),
      row('chat/sess-decoy-c', { chunk_id: 12, score: 0.7 }),
      row('chat/sess-multi-a', { chunk_id: 13, score: 0.6 }),
      row('chat/sess-multi-b', { chunk_id: 14, score: 0.5 }),
    ];
    const r = buildRow({ question: q, hypothesis: 'h', results, k: 2, slugToRaw: map, mode: 'balanced', extra: { intent: 'other' } });
    expect(r.question_id).toBe('mc-2');
    expect(r.question).toBe('sourdough loaves');
    expect(r.question_type).toBe('multi-session');
    expect(r.answer).toBe('twelve');
    expect(r.hypothesis).toBe('h');
    expect(r.abstention).toBe(false);
    // k=2: top-2 chunk rows cover {Sess_MULTI_a, Sess_DECOY_c} -> any but not all.
    expect(r.recall_all_hit).toBe(false);
    expect(r.recall_any_hit).toBe(true);
    expect(r.recall_hit).toBe(true);
    expect(r.gold_total).toBe(2);
    expect(r.gold_found).toBe(1);
    expect(r.distinct_sessions_in_top_k).toBe(2);
    expect(r.retrieved).toEqual([
      { slug: 'chat/sess-multi-a', chunk_id: 11, session_id: 'Sess_MULTI_a', rank: 1, score: 0.9, rerank_score: 0.8, alias_hit: true },
      { slug: 'chat/sess-decoy-c', chunk_id: 12, session_id: 'Sess_DECOY_c', rank: 2, score: 0.7 },
      { slug: 'chat/sess-multi-a', chunk_id: 13, session_id: 'Sess_MULTI_a', rank: 3, score: 0.6 },
      { slug: 'chat/sess-multi-b', chunk_id: 14, session_id: 'Sess_MULTI_b', rank: 4, score: 0.5 },
    ]);
    expect(r.retrieved_session_ids).toEqual(['Sess_MULTI_a', 'Sess_DECOY_c', 'Sess_MULTI_b']);
    expect(r.gold_missing_from_haystack).toEqual([]);
    expect(r.slug_collision).toBe(0);
    expect(r.mode).toBe('balanced');
    expect(r.intent).toBe('other');
    // Larger k over the same rows: all gold present.
    const r5 = buildRow({ question: q, hypothesis: 'h', results, k: 5, slugToRaw: map });
    expect(r5.recall_all_hit).toBe(true);
    expect(r5.distinct_sessions_in_top_k).toBe(3);
    expect('mode' in r5).toBe(false);
  });

  test('empty results: both hits false, distinct 0, empty retrieved', () => {
    const r = buildRow({ question: q, hypothesis: '', results: [], k: 5, slugToRaw: map });
    expect(r.recall_all_hit).toBe(false);
    expect(r.recall_any_hit).toBe(false);
    expect(r.distinct_sessions_in_top_k).toBe(0);
    expect(r.retrieved).toEqual([]);
    expect(r.retrieved_session_ids).toEqual([]);
  });

  test('no gold: recall fields omitted (row stays out of the denominator), abstention flagged', () => {
    const abs = sQuestion('mc-9_abs', ['s_1'], []);
    const r = buildRow({ question: abs, hypothesis: 'h', results: [row('chat/s-1')], k: 5, slugToRaw: buildSlugToRawMap(abs) });
    expect(r.abstention).toBe(true);
    expect('recall_all_hit' in r).toBe(false);
    expect('recall_any_hit' in r).toBe(false);
    expect('recall_hit' in r).toBe(false);
    expect(r.gold_total).toBe(0);
    expect(addRowToBucket(newBucket(), r)).toBe('skipped');
  });

  test('gold missing from haystack and slug collisions are stamped per row', () => {
    const bad = sQuestion('q-bad', ['a_b', 'a-b', 'c_1'], ['c_1', 'ghost']);
    const r = buildRow({ question: bad, hypothesis: 'h', results: [row('chat/c-1')], k: 5, slugToRaw: buildSlugToRawMap(bad) });
    expect(r.gold_missing_from_haystack).toEqual(['ghost']);
    expect(r.slug_collision).toBe(1);
    expect(r.recall_any_hit).toBe(true);
    expect(r.recall_all_hit).toBe(false);
  });

  test('extra never overrides scored fields', () => {
    const r = buildRow({
      question: q, hypothesis: 'h', results: [], k: 5, slugToRaw: map,
      extra: { recall_all_hit: true, question_id: 'spoofed', gold_total: 99 },
    });
    expect(r.recall_all_hit).toBe(false);
    expect(r.question_id).toBe('mc-2');
    expect(r.gold_total).toBe(2);
  });
});

describe('fixture test/fixtures/longmemeval-mixedcase.jsonl', () => {
  const questions = readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as LongMemEvalQuestion);

  test('three _s-shape questions with mixed-case ids, one multi-gold, one _abs', () => {
    expect(questions.map(q => q.question_id)).toEqual(['mc-1', 'mc-2', 'mc-3_abs']);
    for (const q of questions) {
      expect(Array.isArray(q.haystack_session_ids)).toBe(true);
      expect(q.haystack_session_ids!.length).toBe(q.haystack_sessions.length);
      expect(q.haystack_dates!.length).toBe(q.haystack_sessions.length);
      for (const s of q.haystack_sessions) expect(Array.isArray(s)).toBe(true);
      expect(q.answer_session_ids.length).toBeGreaterThan(0);
      // Every id carries something the slug sanitizer changes (the join bug's trigger).
      for (const id of q.haystack_session_ids!) expect(normalizeSessionId(id)).not.toBe(id);
      const map = buildSlugToRawMap(q);
      expect(detectSlugCollisions(map)).toEqual([]);
      expect(goldMissingFromHaystack(map, q.answer_session_ids)).toEqual([]);
      expect(haystackToPages(q).length).toBe(q.haystack_sessions.length);
    }
    expect(questions[1].answer_session_ids).toEqual(['Sess_MULTI_a', 'Sess_MULTI_b']);
    expect(isAbstentionQuestion(questions[2].question_id)).toBe(true);
    expect(questions.filter(q => isAbstentionQuestion(q.question_id)).length).toBe(1);
  });

  test('mc-1: only the gold session carries every query token; mc-2: only ONE gold does', () => {
    const tokens = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9-]+/g) ?? []);
    const stop = new Set(['the', 'to', 'for', 'did', 'how', 'many', 'which', 'wants', 'near']);
    const containsAll = (text: string, query: string) => {
      const t = tokens(text);
      return [...tokens(query)].filter(w => !stop.has(w)).every(w => t.has(w));
    };
    const sessionText = (q: LongMemEvalQuestion, i: number) =>
      (q.haystack_sessions[i] as { content: string }[]).map(t => t.content).join(' ');

    const mc1 = questions[0];
    const mc1Hits = mc1.haystack_session_ids!.filter((_, i) => containsAll(sessionText(mc1, i), mc1.question));
    expect(mc1Hits).toEqual(['sharegpt_yywfIrx_0']);

    const mc2 = questions[1];
    const mc2Hits = mc2.haystack_session_ids!.filter((_, i) => containsAll(sessionText(mc2, i), mc2.question));
    expect(mc2Hits).toEqual(['Sess_MULTI_a']);
    // Scoring that hit set reproduces the fixture's contract.
    expect(scoreRecall(mc2Hits, mc2.answer_session_ids, 5)).toMatchObject({ recall_all_hit: false, recall_any_hit: true });
  });
});
