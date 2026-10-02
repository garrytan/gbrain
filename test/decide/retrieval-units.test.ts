/**
 * System One retrieval slots, pure logic with fixture answers: S2 intent
 * reducer (regex default and tie source), S4 k rule and abstention reducer,
 * S5 flagging and same-class demotion that never crosses the min_keep cut,
 * the Jev-reranker egress check, the dataset builders/adapters for these
 * slots (LongMemEval question_type + abstention, BrainBench relational, the
 * #5178 injection known cases), and the explain answer line.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduceIntent, intentRequest, SEARCH_INTENT_OPTIONS, THINK_INTENT_OPTIONS } from '../../src/core/ai/decide/intent.ts';
import { answerableK, answerableQuestion, reduceAnswerable, ANSWERABLE_MAX_K } from '../../src/core/ai/decide/answerable.ts';
import { demoteFlagged, reduceInjection } from '../../src/core/ai/decide/injection.ts';
import { datasetAdapter, datasetBuilder, itemForCallSite } from '../../src/core/ai/decide/dataset.ts';
import { SLOT_SPECS } from '../../src/core/ai/decide/slots.ts';
import { readDecideConfig } from '../../src/core/ai/decide/config.ts';
import { rerankEgressDenied } from '../../src/core/search/decide-retrieval.ts';
import { formatDecideSummary } from '../../src/core/search/explain-formatter.ts';
import type { ChoiceAnswer, EvidenceItem } from '../../src/core/ai/decide/types.ts';
import type { SearchResult } from '../../src/core/types.ts';

const choice = (label: string, probabilities: Record<string, number>): ChoiceAnswer => ({ kind: 'choice', choice: label, confidence: probabilities[label] ?? 0, probabilities });

describe('S2 intent reducer', () => {
  test('an above-threshold label different from the regex label overrides', () => {
    expect(reduceIntent(choice('temporal', { temporal: 0.8, general: 0.1 }), 'general', { threshold: 0.6 }, 'search')).toEqual({ outcome: 'override', label: 'temporal', p: 0.8 });
  });
  test('below threshold, same label, unknown label or no answer keeps the regex label', () => {
    expect(reduceIntent(choice('temporal', { temporal: 0.5 }), 'general', { threshold: 0.6 }, 'search').outcome).toBe('fallback_regex');
    expect(reduceIntent(choice('general', { general: 0.9 }), 'general', { threshold: 0.6 }, 'search')).toEqual({ outcome: 'fallback_regex', label: 'general', p: 0.9 });
    expect(reduceIntent(choice('knowledge_update', { knowledge_update: 0.9 }), 'general', { threshold: 0.6 }, 'search').label).toBe('general');
    expect(reduceIntent(undefined, 'entity', { threshold: 0.6 }, 'search')).toEqual({ outcome: 'fallback_regex', label: 'entity', p: null });
  });
  test('a tie with the regex label goes to the regex label', () => {
    expect(reduceIntent(choice('event', { event: 0.45, temporal: 0.45 }), 'temporal', { threshold: 0.4 }, 'search')).toEqual({ outcome: 'fallback_regex', label: 'temporal', p: 0.45 });
  });
  test('think labels are the trajectory buckets', () => {
    expect(reduceIntent(choice('knowledge_update', { knowledge_update: 0.9 }), 'other', { threshold: 0.6 }, 'think').label).toBe('knowledge_update');
    expect(Object.keys(THINK_INTENT_OPTIONS)).toEqual(['temporal', 'knowledge_update', 'other']);
    expect(Object.keys(SEARCH_INTENT_OPTIONS)).toEqual(['entity', 'temporal', 'event', 'concept', 'general']);
    const req = intentRequest('when did we ship', 'think');
    expect(req.state.query!.class).toBe('query');
    expect(req.questions[0]!.kind).toBe('choice');
  });
  test('wait bound defaults to 150 ms and is configurable', () => {
    expect(readDecideConfig(null).intentWaitMs).toBe(250);
    expect(readDecideConfig({ 'decide.slots.intent.wait_ms': '40' }).intentWaitMs).toBe(40);
  });
});

const item = (text: string, i: number): EvidenceItem => ({ text, class: 'candidates', slug: `s/${i}`, source_id: 'default' });

describe('S4 k rule and reducer', () => {
  test('k = min(10, n), shrunk until state + question fit 32k; 0 when nothing fits or n is 0', () => {
    expect(answerableK('q', Array.from({ length: 4 }, (_, i) => item('short', i)))).toBe(4);
    expect(answerableK('q', Array.from({ length: 30 }, (_, i) => item('short', i)))).toBe(ANSWERABLE_MAX_K);
    const big = 'lorem ipsum dolor sit amet '.repeat(700);
    const k = answerableK('q', Array.from({ length: 10 }, (_, i) => item(big, i)));
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThan(10);
    expect(answerableK('q', [item('x '.repeat(40_000), 0)])).toBe(0);
    expect(answerableK('q', [])).toBe(0);
    expect(Object.keys(answerableQuestion([item('a', 0), item('b', 1)]).inputs!)).toEqual(['candidate_1', 'candidate_2']);
  });
  const policy = { threshold: 0.5, margin: 0.05 };
  const none = { complete: true, identityHit: false, strongGrade: false };
  test('abstains only below the margin, with complete coverage and no deterministic signal', () => {
    expect(reduceAnswerable(0.6, policy, none)).toBe('pass');
    expect(reduceAnswerable(0.6, policy, { ...none, complete: false })).toBe('pass');
    expect(reduceAnswerable(0.1, policy, { ...none, complete: false })).toBe('incomplete');
    expect(reduceAnswerable(0.47, policy, none)).toBe('margin_hold');
    expect(reduceAnswerable(0.1, policy, { ...none, identityHit: true })).toBe('pass');
    expect(reduceAnswerable(0.1, policy, { ...none, strongGrade: true })).toBe('pass');
    expect(reduceAnswerable(0.1, policy, none)).toBe('abstain');
  });
});

describe('S5 injection', () => {
  test('flags at or above threshold, never a protected or unjudged candidate', () => {
    expect(reduceInjection([
      { id: 'a', p: 0.9, protected: false }, { id: 'b', p: 0.9, protected: true }, { id: 'c', p: null, protected: false }, { id: 'd', p: 0.2, protected: false },
    ], { threshold: 0.7 })).toEqual({ a: 'demoted', b: 'kept', c: 'kept', d: 'kept' });
  });
  test('moves flagged items below clean items of the same class, keeps every item, never crosses the cut', () => {
    const pool = ['A1', 'B1', 'A2', 'A3', 'B2', 'A4'];
    const cls = (s: string) => s[0]!;
    expect(demoteFlagged(pool, new Set(['A3']), cls, 0)).toEqual(['A1', 'B1', 'A2', 'A4', 'B2', 'A3']);
    expect(demoteFlagged(pool, new Set(['A1']), cls, 0)).toEqual(['A2', 'B1', 'A3', 'A4', 'B2', 'A1']);
    // cut 3: A1 stays inside the top 3 (moves below A2), A4 cannot rise above the cut
    expect(demoteFlagged(pool, new Set(['A1']), cls, 3)).toEqual(['A2', 'B1', 'A1', 'A3', 'B2', 'A4']);
    expect(demoteFlagged(pool, new Set(['B2']), cls, 3)).toEqual(pool);
    const out = demoteFlagged(pool, new Set(['A1', 'B1', 'A4']), cls, 2);
    expect([...out].sort()).toEqual([...pool].sort());
  });
});

describe('Jev reranker egress check', () => {
  const head = [{ source_id: 'default' }, { source_id: 'work' }] as SearchResult[];
  test('skips only for the Jev reranker with a denied candidate source', () => {
    const snap = { 'decide.egress.deny_sources': '["work"]' };
    expect(rerankEgressDenied(snap, 'typesafe:jev-1.13.0', head)).toBe(true);
    expect(rerankEgressDenied(snap, 'voyage:rerank-2.5', head)).toBe(false);
    expect(rerankEgressDenied(snap, 'typesafe:jev-1.13.0', head.slice(0, 1))).toBe(false);
    expect(rerankEgressDenied(undefined, 'typesafe:jev-1.13.0', head)).toBe(false);
    expect(rerankEgressDenied({ 'decide.egress.deny_sources': 'garbage' }, 'typesafe:jev-1.13.0', head)).toBe(false);
  });
});

describe('slot specs', () => {
  test('S2, S4 and S5 are wired; S5 runs at search and think; S4 acts in think', () => {
    expect(SLOT_SPECS.intent.wired && SLOT_SPECS.answerable.wired && SLOT_SPECS.injection.wired).toBe(true);
    expect(SLOT_SPECS.injection.callSites).toEqual(['search', 'think']);
    expect(SLOT_SPECS.answerable.callSites[0]).toBe('think');
  });
});

describe('datasets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-retrieval-ds-'));
  const lme = join(dir, 'lme.json');
  writeFileSync(lme, JSON.stringify([
    { question_id: 'q1', question_type: 'temporal-reasoning', question: 'When did I adopt the dog?', haystack_session_ids: ['a', 'b'], haystack_sessions: [[{ role: 'user', content: 'adopted in may' }], [{ role: 'user', content: 'weather' }]], answer_session_ids: ['a'] },
    { question_id: 'q2', question_type: 'knowledge-update', question: 'Where do I live now?', haystack_session_ids: ['a'], haystack_sessions: [[{ role: 'user', content: 'moved to lisbon' }]], answer_session_ids: ['a'] },
    { question_id: 'q3_abs', question_type: 'single-session-user', question: 'What is my cat called?', haystack_session_ids: ['a', 'b'], haystack_sessions: [[{ role: 'user', content: 'I have a dog' }], [{ role: 'user', content: 'hi' }]], answer_session_ids: ['a'] },
    { question_id: 'q4', question_type: 'single-session-user', question: 'What degree did I get?', haystack_session_ids: ['a'], haystack_sessions: [[{ role: 'user', content: 'BSc' }]], answer_session_ids: ['a'] },
  ]));

  test('intent from LongMemEval question_type: search and think labels, call site carried in state', async () => {
    const items = await datasetBuilder('longmemeval')!(lme, { slot: 'intent' });
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId['lme:q1:search']!.label).toBe('temporal');
    expect(byId['lme:q1:think']!.label).toBe('temporal');
    expect(byId['lme:q2:search']!.label).toBe('temporal');
    expect(byId['lme:q2:think']!.label).toBe('knowledge_update');
    expect(byId['lme:q4:search']).toBeUndefined();
    expect(byId['lme:q4:think']!.label).toBe('other');
    expect(items.some((i) => i.id.includes('q3_abs'))).toBe(false);
    expect(itemForCallSite(byId['lme:q2:think']!, 'search')).toBe(false);
    const adapter = datasetAdapter('intent')!;
    const req = adapter.request([byId['lme:q2:think']!]);
    expect(Object.keys((req.questions[0] as { options: Record<string, string> }).options)).toEqual(Object.keys(THINK_INTENT_OPTIONS));
    expect(req.state).toEqual({ query: { text: 'Where do I live now?', class: 'query' } });
    expect(adapter.positive!(byId['lme:q2:think']!, choice('knowledge_update', { knowledge_update: 0.9 }))).toBe(true);
    expect(adapter.positive!(byId['lme:q2:think']!, choice('temporal', { temporal: 0.9 }))).toBe(false);
  });

  test('intent from BrainBench relational cases', async () => {
    const items = await datasetBuilder('brainbench')!(join(import.meta.dir, '../fixtures/retrieval-quality/relational/relational.jsonl'), { slot: 'intent' });
    expect(items.length).toBeGreaterThan(10);
    expect(new Set(items.filter((i) => i.state.call_site === 'search').map((i) => i.label))).toEqual(new Set(['general']));
    expect(new Set(items.filter((i) => i.state.call_site === 'think').map((i) => i.label))).toEqual(new Set(['other']));
  });

  test('answerable from LongMemEval: abstention questions are the negatives; the adapter uses the production k rule', async () => {
    const items = await datasetBuilder('longmemeval')!(lme, { slot: 'answerable' });
    const abs = items.find((i) => i.id === 'lme:q3_abs')!;
    expect(abs.label).toBe(false);
    expect(abs.slice).toBe('single-session-user:abstention');
    expect(items.find((i) => i.id === 'lme:q1')!.label).toBe(true);
    expect(Object.keys(abs.inputs)).toEqual(['candidate_1', 'candidate_2']);
    const adapter = datasetAdapter('answerable')!;
    expect(adapter.request([abs]).questions).toHaveLength(1);
    const actions = adapter.harmfulActions!([abs], { [abs.id]: 0.1 }, { threshold: 0.5, margin: 0.05, minKeep: 0 });
    expect(actions).toEqual([{ item: abs, correct: true }]);
    expect(adapter.harmfulActions!([{ ...abs, protected: true }], { [abs.id]: 0.1 }, { threshold: 0.5, margin: 0.05, minKeep: 0 })).toEqual([]);
  });

  test('evidence builds still route through the S3 LongMemEval builder', async () => {
    const items = await datasetBuilder('longmemeval')!(lme, { slot: 'evidence' });
    expect(items.find((i) => i.id === 'q1:a')!.label).toBe(true);
  });

  test('evidence builder keeps the first occurrence of a repeated haystack session id', async () => {
    const dup = join(dir, 'lme-dup.json');
    writeFileSync(dup, JSON.stringify([{ question_id: 'q9', question_type: 'multi-session', question: 'Q?', haystack_session_ids: ['a', 'b', 'a'], haystack_sessions: [[{ role: 'user', content: 'first' }], [{ role: 'user', content: 'other' }], [{ role: 'user', content: 'first again' }]], answer_session_ids: ['a'] }]));
    const items = await datasetBuilder('longmemeval')!(dup, { slot: 'evidence' });
    expect(items.map((i) => i.id)).toEqual(['q9:a', 'q9:b']);
    expect(items[0]!.inputs.candidate).toContain('first');
  });

  test('injection from the #5178 known cases: attack candidates are positive, quoted payloads are not', async () => {
    const items = await datasetBuilder('injection-fixtures')!(join(import.meta.dir, '../fixtures/decide/injection-cases.jsonl'), { slot: 'injection' });
    expect(items.filter((i) => i.label === true).map((i) => i.family).sort()).toEqual(['inj:forged-json', 'inj:injected-command', 'inj:quoted-injection', 'inj:self-rating']);
    expect(items.find((i) => i.id === 'inj:quoted-injection:gold')!.label).toBe(false);
    const fam = items.filter((i) => i.family === 'inj:injected-command');
    const req = datasetAdapter('injection')!.request(fam);
    expect(req.questions.map((q) => q.id)).toEqual(['evidence:0', 'injection:0', 'evidence:1', 'injection:1', 'evidence:2', 'injection:2']);
    expect(Object.keys(req.itemFor)).toEqual(['injection:0', 'injection:1', 'injection:2']);
  });
});

describe('explain lines', () => {
  test('S2/S4/S5 lines carry the answer summary and outcomes', () => {
    const out = formatDecideSummary({
      intent: { mode: 'on', effective: 'on', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.6, answer: 'temporal p 0.80 (regex general) → temporal', outcomes: { override: 1 } },
      answerable: { mode: 'on', effective: 'on', provider: 'typesafe:jev-1.13.0', threshold: 0.5, answer: 'p 0.20, verdict abstain, k 3', outcomes: { abstain: 1 } },
      injection: { mode: 'on', effective: 'on', provider: 'typesafe:jev-1.13.0', threshold: 0.7, judged: 3, outcomes: { demoted: 1, kept: 2 } },
    })!;
    expect(out).toContain('decide intent: on — typesafe:jev-1.13.0 (resolved jev-1.13.0); temporal p 0.80 (regex general) → temporal; threshold 0.6; override 1');
    expect(out).toContain('decide answerable: on — typesafe:jev-1.13.0; p 0.20, verdict abstain, k 3; threshold 0.5; abstain 1');
    expect(out).toContain('decide injection: on — typesafe:jev-1.13.0; judged 3; threshold 0.7; demoted 1, kept 2');
  });
});
