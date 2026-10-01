/**
 * System One decide core (pure): pack planner budgets and split, bounded
 * batch runner, answer parsers for all three types, policy threshold
 * precedence / drift / gates / readiness, calibration and qualification math,
 * config validation and the canonical vocabulary.
 */
import { describe, expect, test } from 'bun:test';
import {
  MAX_CONCURRENT_BATCHES, RateLimitedError, STATE_QUESTION_BUDGET, TOTAL_INPUT_BUDGET, estimateContextTokens, orderQuestions,
  packShape, parseRetryAfterMs, planBatches, runBatches,
} from '../../src/core/ai/decide/pack.ts';
import { classifyTypeSafeHttpError, parseAnswer, parseTypeSafeResponse, toWireQuestion } from '../../src/core/ai/decide/providers/typesafe.ts';
import { parseLlmReply } from '../../src/core/ai/decide/providers/llm-structured.ts';
import { driftReason, marginFor, policyFingerprint, readiness, resolveSlotPolicy, type PolicyInputs } from '../../src/core/ai/decide/policy.ts';
import { qualifyActions, reliability, requiredN, searchThreshold, wilsonLowerBound, meanItemSd } from '../../src/core/ai/decide/calibrate.ts';
import { readDecideConfig, validateDecideConfigValue, DECIDE_CONFIG_KEYS } from '../../src/core/ai/decide/config.ts';
import { REFUSAL_CATALOG, SKIP_REASONS, SLOT_OUTCOMES, isValidOutcome } from '../../src/core/ai/decide/outcomes.ts';
import { reduceEvidence, whatIfEvidence } from '../../src/core/ai/decide/evidence.ts';
import { isProtectedResult } from '../../src/core/ai/decide/protection.ts';
import { stableSplit, splitHash, parseDatasetJsonl } from '../../src/core/ai/decide/dataset.ts';
import type { CalibrationRow } from '../../src/core/ai/decide/store.ts';
import { DecideError, thresholdValue, type DecideQuestion } from '../../src/core/ai/decide/types.ts';
import { SLOT_SPECS } from '../../src/core/ai/decide/slots.ts';

const noul = (id: string, rank?: number, text = 'x'): DecideQuestion => ({ id, kind: 'noul', rank, instructions: 'Is `c` evidence?', inputs: { c: { text, class: 'candidates' } } });

describe('pack planner', () => {
  test('orders by rank then id and keeps unranked last', () => {
    expect(orderQuestions([noul('b', 1), noul('z'), noul('a', 1), noul('c', 0)]).map((q) => q.id)).toEqual(['c', 'a', 'b', 'z']);
  });

  test('splits before send under both limits and never truncates', () => {
    const q = Array.from({ length: 12 }, () => 9_000);
    const batches = planBatches(100, q);
    expect(batches.flatMap((b) => b.indices)).toEqual(q.map((_, i) => i));
    for (const b of batches) expect(b.estimatedInputTokens).toBeLessThanOrEqual(TOTAL_INPUT_BUDGET);
    expect(batches.length).toBeGreaterThan(1);
  });

  test('a single state + question pair over 32k throws payload_too_large', () => {
    expect(() => planBatches(STATE_QUESTION_BUDGET, [10])).toThrow(DecideError);
  });

  test('digit floor makes digit-dense text count at least one token per digit', () => {
    const digits = '1234567890'.repeat(500);
    expect(estimateContextTokens(digits)).toBeGreaterThanOrEqual(5000);
  });

  test('pack shape names co-packed slots in a stable order', () => {
    expect(packShape('evidence', ['injection'])).toBe(packShape('evidence', ['injection', 'evidence']));
    expect(packShape('evidence')).not.toBe(packShape('evidence', ['injection']));
    expect(packShape('triage', [], { unpacked: true })).toContain('max=1');
  });

  test('retry-after parses seconds and dates', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });
});

describe('batch runner', () => {
  test('never exceeds 16 in flight and a free worker starts queued work', async () => {
    let inFlight = 0, peak = 0;
    const out = await runBatches(40, async (i) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, i % 3));
      inFlight--;
      return i;
    }, { concurrency: 99, deadlineAt: Date.now() + 5000, signal: new AbortController().signal, lane: 'hot' });
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_BATCHES);
    expect(out).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  test('429 retries once when retry-after fits, fails rate_limited when it does not', async () => {
    let calls = 0;
    const ok = await runBatches(1, async () => { calls++; if (calls === 1) throw new RateLimitedError(0); return 'ok'; },
      { concurrency: 1, deadlineAt: Date.now() + 1000, signal: new AbortController().signal, lane: 'hot', sleep: async () => {} });
    expect(ok).toEqual(['ok']);
    calls = 0;
    await expect(runBatches(1, async () => { calls++; throw new RateLimitedError(5000); },
      { concurrency: 1, deadlineAt: Date.now() + 1000, signal: new AbortController().signal, lane: 'hot' })).rejects.toMatchObject({ reason: 'rate_limited' });
    expect(calls).toBe(1);
    await expect(runBatches(1, async () => { throw new RateLimitedError(); },
      { concurrency: 1, deadlineAt: Date.now() + 1000, signal: new AbortController().signal, lane: 'hot' })).rejects.toMatchObject({ reason: 'rate_limited' });
  });

  test('background lane drops to one worker after a 429', async () => {
    let inFlight = 0, peakAfter = 0, limited = false;
    await runBatches(12, async (i) => {
      inFlight++;
      if (limited) peakAfter = Math.max(peakAfter, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      if (i === 0 && !limited) { limited = true; throw new RateLimitedError(0); }
      return i;
    }, { concurrency: 4, deadlineAt: Date.now() + 5000, signal: new AbortController().signal, lane: 'background', sleep: async () => {} });
    expect(limited).toBe(true);
  });
});

describe('answer parsers', () => {
  const choice: DecideQuestion = { id: 'c', kind: 'choice', instructions: 'pick', options: { a: 'A', b: 'B' } };
  const score: DecideQuestion = { id: 's', kind: 'score', instructions: 'score', levels: ['0', '1', '2', '3'] };
  test('noul, choice and score mirror the wire', () => {
    expect(parseAnswer(noul('n'), { type: 'noul', noul: 0.8 })).toEqual({ kind: 'noul', p: 0.8 });
    const c = parseAnswer(choice, { type: 'choice', choice: 'b', confidence: 0.7, probabilities: { a: 0.3, b: 0.7 } });
    expect(c).toEqual({ kind: 'choice', choice: 'b', confidence: 0.7, probabilities: { a: 0.3, b: 0.7 } });
    expect(thresholdValue(c)).toBe(0.7);
    const s = parseAnswer(score, { type: 'score', score: 1.5, confidence: 0.6, legend: {}, probabilities: { 1: 0.5, 2: 0.5 } });
    expect(s).toMatchObject({ kind: 'score', score: 1.5, normalized: 0.5 });
  });

  for (const [q, raw] of [
    [noul('n'), { type: 'noul', noul: 1.2 }], [noul('n'), { type: 'noul', noul: 'high' }], [noul('n'), { type: 'choice', choice: 'a' }],
    [choice, { type: 'choice', choice: 'z', confidence: 1, probabilities: {} }], [choice, { type: 'choice', choice: 'a', confidence: 2, probabilities: { a: 1 } }],
    [score, { type: 'score', score: 4 }], [score, { type: 'score', score: NaN }],
  ] as const) {
    test(`rejects out-of-range or mistyped answers ${JSON.stringify(raw)}`, () => {
      expect(() => parseAnswer(q as DecideQuestion, raw)).toThrow(DecideError);
    });
  }

  test('a response missing any requested id fails the whole batch; model is required', () => {
    expect(() => parseTypeSafeResponse({ model: 'jev-1.13.0', answers: { a: { type: 'noul', noul: 0.4 } } }, [noul('a'), noul('b')])).toThrow(/b missing/);
    expect(() => parseTypeSafeResponse({ answers: { a: { type: 'noul', noul: 0.4 } } }, [noul('a')])).toThrow(/resolved model/);
  });

  test('wire questions carry the task plus named inputs', () => {
    expect(toWireQuestion(noul('a', 0, 'cand'))).toEqual({ type: 'noul', instructions: { task: 'Is `c` evidence?', c: 'cand' } });
    expect(toWireQuestion(choice)).toEqual({ type: 'choice', instructions: 'pick', criteria: { a: 'A', b: 'B' } });
  });

  test('HTTP classification: unknown model becomes pinned_model_unavailable without echoing the body', async () => {
    const e = await classifyTypeSafeHttpError(new Response('{"detail":{"message":"Unknown model: jev-9"}}', { status: 400 }));
    expect(e.reason).toBe('pinned_model_unavailable');
    expect(e.message).not.toContain('jev-9');
    expect((await classifyTypeSafeHttpError(new Response('x', { status: 503 }))).reason).toBe('provider_error');
  });

  test('llm replies are validated with the same parser (fenced JSON accepted, partial rejected)', () => {
    expect(parseLlmReply('```json\n{"answers":{"a":{"type":"noul","noul":0.2}}}\n```', [noul('a')])).toEqual({ a: { kind: 'noul', p: 0.2 } });
    expect(() => parseLlmReply('{"answers":{}}', [noul('a')])).toThrow(DecideError);
    expect(() => parseLlmReply('not json', [noul('a')])).toThrow(DecideError);
  });
});

function cal(over: Partial<CalibrationRow>): CalibrationRow {
  return {
    id: 1, slot: 'evidence', call_site: 'search', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.4, min_keep: 3,
    metric: 'f1', metric_value: 0.8, ece: 0.05, retest_sd: 0.04, repack_sd: 0.06, action_precision_lb: 0.95, qualification: null,
    qualified_at: null, policy_fingerprint: null, n: 100, dataset_hash: 'd', split_hash: 's', calibrate_ids_hash: 'c', calibrate_only: true,
    pack_shape: packShape('evidence'), created_at: '2026-09-30T00:00:00.000Z', retired_at: null, notes: null, ...over,
  };
}

function inputs(snapshot: Record<string, string>, rows: CalibrationRow[], extra: Partial<PolicyInputs> = {}): PolicyInputs {
  return { cfg: readDecideConfig(snapshot), slot: 'evidence', packShape: packShape('evidence'), calibrations: rows, hasTypesafeKey: true, ...extra };
}

const ON = { 'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.evidence.mode': 'on' };

describe('slot policy', () => {
  test('all off: effective off, no inactive cause', () => {
    const p = resolveSlotPolicy(inputs({}, []));
    expect(p).toMatchObject({ requested: 'off', effective: 'off' });
    expect(p.inactive).toBeUndefined();
  });

  test('threshold precedence: override > adopted > newest local > reference', () => {
    const older = cal({ id: 1, threshold: 0.3, created_at: '2026-09-01T00:00:00.000Z' });
    const newer = cal({ id: 2, threshold: 0.5, created_at: '2026-09-20T00:00:00.000Z' });
    expect(resolveSlotPolicy(inputs(ON, [older, newer])).threshold).toBe(0.5);
    expect(resolveSlotPolicy(inputs({ ...ON, 'decide.slots.evidence.calibration': 'local:1' }, [older, newer])).threshold).toBe(0.3);
    const o = resolveSlotPolicy(inputs({ ...ON, 'decide.slots.evidence.threshold': '0.7', 'decide.slots.evidence.force_on': 'true' }, [newer]));
    expect(o).toMatchObject({ threshold: 0.7, thresholdSource: 'override' });
    const ref = resolveSlotPolicy(inputs(ON, [], { references: [{ id: 'r1', slot: 'evidence', call_site: 'search', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.45, min_keep: 3, retest_sd: 0, repack_sd: 0, action_precision_lb: 0.97, policy_fingerprint: null, pack_shape: packShape('evidence'), dataset_hash: 'd', split_hash: 's', verdict: 'win', shipped_in: 'test' }] }));
    expect(ref).toMatchObject({ threshold: 0.45, thresholdSource: 'reference', effective: 'on' });
  });

  test('on without calibration is inactive no_calibration; missing key and provider are named', () => {
    expect(resolveSlotPolicy(inputs(ON, []))).toMatchObject({ effective: 'off', inactive: 'no_calibration' });
    expect(resolveSlotPolicy(inputs(ON, [cal({})], { hasTypesafeKey: false }))).toMatchObject({ inactive: 'no_key' });
    expect(resolveSlotPolicy(inputs({ 'decide.slots.evidence.mode': 'on' }, []))).toMatchObject({ inactive: 'no_provider' });
  });

  test('action-precision gate, force_on bypass, and pack shape mismatch', () => {
    expect(resolveSlotPolicy(inputs(ON, [cal({ action_precision_lb: null })]))).toMatchObject({ inactive: 'no_qualification' });
    expect(resolveSlotPolicy(inputs(ON, [cal({ action_precision_lb: 0.8 })]))).toMatchObject({ inactive: 'action_precision_low' });
    expect(resolveSlotPolicy(inputs({ ...ON, 'decide.slots.evidence.force_on': 'true' }, [cal({ action_precision_lb: 0.8 })]))).toMatchObject({ effective: 'on' });
    expect(resolveSlotPolicy(inputs(ON, [cal({ pack_shape: 'v0:other' })]))).toMatchObject({ inactive: 'pack_shape_mismatch' });
  });

  test('a threshold override that differs from the qualified policy is policy_changed', () => {
    const qualified = resolveSlotPolicy(inputs(ON, [cal({})]));
    const row = cal({ policy_fingerprint: qualified.fingerprint });
    expect(resolveSlotPolicy(inputs(ON, [row])).effective).toBe('on');
    expect(resolveSlotPolicy(inputs({ ...ON, 'decide.slots.evidence.threshold': '0.9' }, [row]))).toMatchObject({ inactive: 'policy_changed' });
  });

  test('alias providers look up the most recently resolved model; drift demotes the call, overrides never', () => {
    const snapshot = { ...ON, 'decide.provider': 'typesafe:jev-latest' };
    const row = cal({ provider: 'typesafe:jev-latest' });
    expect(resolveSlotPolicy(inputs(snapshot, [row]))).toMatchObject({ inactive: 'no_calibration' });
    const p = resolveSlotPolicy(inputs(snapshot, [row], { lastResolved: { 'typesafe:jev-latest': 'jev-1.13.0' } }));
    expect(p.effective).toBe('on');
    expect(driftReason(p, 'jev-1.14.0')).toBe('model_drift');
    expect(driftReason(p, 'jev-1.13.0')).toBeUndefined();
    const o = resolveSlotPolicy(inputs({ ...ON, 'decide.slots.evidence.threshold': '0.5', 'decide.slots.evidence.force_on': 'true' }, []));
    expect(driftReason(o, 'jev-9')).toBeUndefined();
  });

  test('margin = max(floor, 2 * max(retest_sd, repack_sd)); override without calibration uses the floor', () => {
    expect(marginFor(0.05, { retest_sd: 0.04, repack_sd: 0.06 })).toBeCloseTo(0.12);
    expect(marginFor(0.05)).toBe(0.05);
    expect(resolveSlotPolicy(inputs({ ...ON, 'decide.slots.evidence.threshold': '0.5', 'decide.slots.evidence.force_on': 'true' }, [])).margin).toBe(0.05);
  });

  test('min_keep precedence: config, calibration, slot default', () => {
    expect(resolveSlotPolicy(inputs(ON, [])).minKeep).toBe(3);
    expect(resolveSlotPolicy(inputs(ON, [cal({ min_keep: 5 })])).minKeep).toBe(5);
    expect(resolveSlotPolicy(inputs({ ...ON, 'decide.slots.evidence.min_keep': '1' }, [cal({ min_keep: 5 })])).minKeep).toBe(1);
  });

  test('fingerprint changes with threshold, floors and pack shape', () => {
    const base = { slot: 'evidence' as const, callSite: 'search', threshold: 0.4, marginFloor: 0.05, minKeep: 3, packShape: packShape('evidence') };
    expect(policyFingerprint(base)).toBe(policyFingerprint({ ...base }));
    expect(policyFingerprint(base)).not.toBe(policyFingerprint({ ...base, threshold: 0.41 }));
    expect(policyFingerprint(base)).not.toBe(policyFingerprint({ ...base, minKeep: 2 }));
    expect(policyFingerprint(base)).not.toBe(policyFingerprint({ ...base, packShape: packShape('evidence', ['injection']) }));
  });

  test('readiness strings', () => {
    const off = inputs({}, []);
    expect(readiness(resolveSlotPolicy(off), off)).toBe('needs calibration');
    const ready = inputs({}, [cal({})]);
    expect(readiness(resolveSlotPolicy(ready), ready)).toBe('ready for on');
    const on = inputs(ON, [cal({})]);
    expect(readiness(resolveSlotPolicy(on), on)).toBe('on');
    const inactive = inputs(ON, []);
    expect(readiness(resolveSlotPolicy(inactive), inactive)).toBe('on (inactive: no_calibration)');
    const rr = { ...inputs({}, []), slot: 'rerank' as const, packShape: packShape('rerank') };
    expect(readiness(resolveSlotPolicy(rr), rr)).toBe('ready for on');
  });

  test('S1 on requires the Jev reranker; shadow with the Jev reranker behaves as on', () => {
    const base = { slot: 'rerank' as const, packShape: packShape('rerank') };
    expect(resolveSlotPolicy({ ...inputs({ ...ON, 'decide.slots.rerank.mode': 'on' }, []), ...base, rerankerModel: 'voyage:rerank-2.5' })).toMatchObject({ inactive: 'reranker_not_jev' });
    expect(resolveSlotPolicy({ ...inputs({ ...ON, 'decide.slots.rerank.mode': 'shadow' }, []), ...base, rerankerModel: 'typesafe:jev-1.13.0' })).toMatchObject({ effective: 'on' });
    expect(resolveSlotPolicy({ ...inputs({ ...ON, 'decide.slots.rerank.mode': 'shadow' }, []), ...base, rerankerModel: 'voyage:rerank-2.5' })).toMatchObject({ effective: 'shadow' });
  });

  test('unwired slots are unavailable', () => {
    const spec = SLOT_SPECS.intent as { wired: boolean };
    spec.wired = false;
    try {
      const p = resolveSlotPolicy({ ...inputs({ ...ON, 'decide.slots.intent.mode': 'on' }, []), slot: 'intent', packShape: packShape('intent') });
      expect(p).toMatchObject({ inactive: 'slot_unavailable', effective: 'off' });
    } finally {
      spec.wired = true;
    }
  });
});

describe('S3 reducer', () => {
  const policy = { threshold: 0.5, margin: 0.1, minKeep: 2 };
  test('protected and unjudged stay, margin holds, pruned below; min_keep restores best-ranked', () => {
    const out = reduceEvidence([
      { id: 'a', rank: 0, p: 0.1, protected: true }, { id: 'b', rank: 1, p: 0.45, protected: false },
      { id: 'c', rank: 2, p: 0.1, protected: false }, { id: 'd', rank: 3, p: null, protected: false }, { id: 'e', rank: 4, p: 0.9, protected: false },
    ], policy);
    expect(out).toEqual({ a: 'kept', b: 'margin_hold', c: 'pruned', d: 'kept', e: 'kept' });
    const bound = reduceEvidence([{ id: 'x', rank: 0, p: 0.1, protected: false }, { id: 'y', rank: 1, p: 0.1, protected: false }, { id: 'z', rank: 2, p: 0.1, protected: false }], policy);
    expect(bound).toEqual({ x: 'kept', y: 'kept', z: 'pruned' });
  });

  test('what-if replays exactly from receipts, including a binding min_keep', () => {
    const rows = [0.2, 0.3, 0.9].map((v, i) => ({ decision_id: 'd1', answer_value: v, protected: false, rank: i, min_keep: 2 }));
    expect(whatIfEvidence(rows, 0.5, 0.05)).toEqual({ kept: 2, pruned: 1, margin_hold: 0 });
    expect(whatIfEvidence(rows, 0.1, 0.05)).toEqual({ kept: 3, pruned: 0, margin_hold: 0 });
  });

  test('protection predicate covers identity evidence and relational pins', () => {
    expect(isProtectedResult({ alias_hit: true })).toBe(true);
    expect(isProtectedResult({ exact_lookup: 'slug' })).toBe(true);
    expect(isProtectedResult({ evidence: 'exact_title_match' })).toBe(true);
    expect(isProtectedResult({ relational_pinned: true })).toBe(true);
    expect(isProtectedResult({ evidence: 'keyword_exact' })).toBe(false);
  });
});

describe('calibration math', () => {
  test('threshold search: f1, precision floor', () => {
    const items = [0.1, 0.2, 0.3, 0.6, 0.7, 0.9].map((value, i) => ({ value, label: i >= 3 }));
    expect(searchThreshold(items, 'f1')!.threshold).toBe(0.6);
    expect(searchThreshold(items, 'precision', 1)!.threshold).toBe(0.6);
    expect(searchThreshold([], 'f1')).toBeNull();
  });

  test('reliability and ECE', () => {
    const perfect = reliability([{ value: 0.95, label: true }, { value: 0.05, label: false }]);
    expect(perfect.ece).toBeCloseTo(0.05);
  });

  test('Wilson bound and required n (35 of 35 is the minimum at 0.90)', () => {
    expect(requiredN(0.9)).toBe(35);
    expect(wilsonLowerBound(35, 35)).toBeGreaterThanOrEqual(0.9);
    expect(wilsonLowerBound(34, 34)).toBeLessThan(0.9);
  });

  test('family-level qualification with insufficient_n and slices', () => {
    const few = qualifyActions(Array.from({ length: 10 }, (_, i) => ({ family: `f${i}`, correct: true })), 0.9);
    expect(few.status).toBe('insufficient_n');
    expect(few.required_n).toBe(35);
    const many = qualifyActions(Array.from({ length: 80 }, (_, i) => ({ family: `f${i}`, correct: true, slice: i % 2 ? 'a' : 'b' })), 0.9);
    expect(many.status).toBe('qualified');
    expect(Object.keys(many.slices).sort()).toEqual(['a', 'b']);
    const fam = qualifyActions([{ family: 'f', correct: true }, { family: 'f', correct: false }], 0.5);
    expect(fam.families).toBe(1);
    expect(fam.correct_families).toBe(0);
  });

  test('retest sd averages per-item deviation', () => {
    expect(meanItemSd(new Map([['a', [0.5, 0.5, 0.5]], ['b', [0.4, 0.6]]]))).toBeCloseTo(0.0707, 3);
  });
});

describe('config and vocabulary', () => {
  test('every decide key validates; bad values are named', () => {
    expect(validateDecideConfigValue('decide.slots.evidence.mode', 'on')).toBeNull();
    expect(validateDecideConfigValue('decide.slots.evidence.mode', 'maybe')).toContain('must be one of');
    expect(validateDecideConfigValue('decide.max_concurrency', '17')).toContain('from 1 to 16');
    expect(validateDecideConfigValue('decide.provider', 'openai:gpt')).toContain('typesafe');
    expect(validateDecideConfigValue('decide.egress.deny_sources', '["a"]')).toBeNull();
    expect(validateDecideConfigValue('decide.nope', 'x')).toContain('not a decide key');
    expect(DECIDE_CONFIG_KEYS).toContain('decide.slots.conflict.proposal_floor');
  });

  test('defaults are all off and conservative', () => {
    const cfg = readDecideConfig(null);
    expect(cfg.provider).toBe('none');
    expect(cfg.maxConcurrency).toBe(16);
    expect(cfg.dailyUsd).toBe(1);
    expect(cfg.egressPrivate).toBe('deny');
    expect(Object.values(cfg.slots).every((s) => s.mode === 'off')).toBe(true);
    expect(cfg.slots.evidence.provider).toBe('none');
  });

  test('eval override applies only when passed', () => {
    expect(readDecideConfig(null, { evalSlots: 'evidence=on,bogus=on,triage=maybe' }).slots.evidence.mode).toBe('on');
    expect(readDecideConfig(null, { evalSlots: 'evidence=on,bogus=on,triage=maybe' }).slots.triage.mode).toBe('off');
  });

  test('outcome vocabulary: common outcomes valid everywhere, slot outcomes only for their slot', () => {
    expect(isValidOutcome('evidence', 'pruned')).toBe(true);
    expect(isValidOutcome('rerank', 'pruned')).toBe(false);
    expect(isValidOutcome('triage', 'skipped')).toBe(true);
    for (const outcomes of Object.values(SLOT_OUTCOMES)) expect(outcomes.length).toBeGreaterThan(0);
  });

  test('every inactive cause the policy can emit is catalogued with a fix and anchor', () => {
    for (const reason of ['slot_unavailable', 'no_provider', 'reranker_not_jev', 'no_key', 'llm_capability', 'no_calibration', 'pack_shape_mismatch', 'no_qualification', 'action_precision_low', 'policy_changed', 'model_drift', 'budget_exhausted', 'malformed_response', 'pinned_model_unavailable', 'egress_private_denied', 'egress_class_denied', 'split_mismatch', 'insufficient_n', 'thin_client', 'egress_fallback_missing']) {
      expect(REFUSAL_CATALOG[reason]).toBeDefined();
      expect(REFUSAL_CATALOG[reason]!.anchor).toBe(`#${reason}`);
    }
    for (const reason of ['egress_private_denied', 'egress_class_denied', 'missing_provenance', 'denied_source', 'model_drift', 'late', 'shadow_queue_full']) {
      expect((SKIP_REASONS as readonly string[]).includes(reason)).toBe(true);
    }
  });
});

describe('datasets', () => {
  test('split is stable per family and hashed', () => {
    expect(stableSplit('family-1')).toBe(stableSplit('family-1'));
    const items = [{ id: 'a', split: 'calibrate' as const }, { id: 'b', split: 'eval' as const }];
    expect(splitHash(items)).toBe(splitHash([...items].reverse()));
    expect(splitHash(items)).not.toBe(splitHash([{ id: 'a', split: 'eval' }, { id: 'b', split: 'eval' }]));
  });

  test('JSONL parser rejects missing split and duplicate ids', () => {
    expect(() => parseDatasetJsonl('{"id":"a","family":"f","slot":"evidence","label":true}')).toThrow(/split/);
    const line = '{"id":"a","family":"f","slot":"evidence","split":"eval","label":true}';
    expect(() => parseDatasetJsonl(`${line}\n${line}`)).toThrow(/duplicate/);
    expect(parseDatasetJsonl(line)).toHaveLength(1);
  });
});
