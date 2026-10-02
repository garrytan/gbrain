/**
 * `gbrain decide judge-agreement` math and input parsing (pure; no provider).
 *
 * Protects: Cohen's kappa and its large-sample 95% CI on hand-computed
 * tables, the degenerate cases (no items, both judges constant), per-slice
 * grouping, nearest-rank percentiles, and the two suites' input parsers
 * (LongMemEval --judge rows skip judge errors / unjudged rows; grounding
 * labels accept the verdict spellings and carry label_source).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agreement, agreementBySlice, confusionOf, percentile, type AgreementPair } from '../../src/core/ai/decide/judge-agreement.ts';
import { loadJudgeItems } from '../../src/commands/decide/judge-agreement.ts';

const pairs = (spec: Array<[boolean, boolean, number]>, slice?: string): AgreementPair[] =>
  spec.flatMap(([reference, predicted, n]) => Array.from({ length: n }, () => ({ reference, predicted, ...(slice ? { slice } : {}) })));

const dir = mkdtempSync(join(tmpdir(), 'gbrain-judge-agreement-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('kappa', () => {
  test('hand-computed 2x2: 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no', () => {
    const a = agreement(pairs([[true, true, 20], [true, false, 5], [false, true, 10], [false, false, 15]]));
    expect(a.n).toBe(50);
    expect(a.confusion).toEqual({ both_yes: 20, reference_yes_jev_no: 5, reference_no_jev_yes: 10, both_no: 15 });
    // po = 0.7; pe = 0.5*0.6 + 0.5*0.4 = 0.5; kappa = 0.4; se = sqrt(0.21 / (50 * 0.25)) = 0.12961
    expect(a.raw_agreement).toBe(0.7);
    expect(a.kappa).toBe(0.4);
    expect(a.kappa_ci95![0]).toBeCloseTo(0.4 - 1.96 * Math.sqrt(0.21 / 12.5), 4);
    expect(a.kappa_ci95![1]).toBeCloseTo(0.4 + 1.96 * Math.sqrt(0.21 / 12.5), 4);
  });

  test('perfect agreement is kappa 1 with a zero-width interval; systematic disagreement is -1', () => {
    const perfect = agreement(pairs([[true, true, 6], [false, false, 4]]));
    expect(perfect.kappa).toBe(1);
    expect(perfect.kappa_ci95).toEqual([1, 1]);
    const opposite = agreement(pairs([[true, false, 5], [false, true, 5]]));
    expect(opposite.kappa).toBe(-1);
    expect(opposite.raw_agreement).toBe(0);
  });

  test('chance-level agreement is kappa 0', () => {
    const a = agreement(pairs([[true, true, 25], [true, false, 25], [false, true, 25], [false, false, 25]]));
    expect(a.kappa).toBe(0);
  });

  test('undefined kappa: no items, or both judges constant on the same label', () => {
    expect(agreement([])).toMatchObject({ n: 0, raw_agreement: null, kappa: null, kappa_ci95: null });
    const constant = agreement(pairs([[true, true, 7]]));
    expect(constant.raw_agreement).toBe(1);
    expect(constant.kappa).toBeNull();
  });

  test('the CI is clamped to [-1, 1]', () => {
    const a = agreement(pairs([[true, true, 2], [false, false, 1], [true, false, 1]]));
    expect(a.kappa_ci95![0]).toBeGreaterThanOrEqual(-1);
    expect(a.kappa_ci95![1]).toBeLessThanOrEqual(1);
  });

  test('slices group by name, sorted; unsliced pairs are left out of slices', () => {
    const all = [...pairs([[true, true, 3]], 'temporal-reasoning'), ...pairs([[false, true, 2]], 'knowledge-update'), ...pairs([[true, true, 1]])];
    const s = agreementBySlice(all);
    expect(Object.keys(s)).toEqual(['knowledge-update', 'temporal-reasoning']);
    expect(s['temporal-reasoning']!.n).toBe(3);
    expect(confusionOf(all).both_yes).toBe(4);
  });

  test('nearest-rank percentiles', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([40, 10, 30, 20], 0.5)).toBe(20);
    expect(percentile([40, 10, 30, 20], 0.95)).toBe(40);
    expect(percentile([5], 0.95)).toBe(5);
  });
});

describe('input parsing', () => {
  test('longmemeval: judged rows become items; judge errors, budget skips, unjudged and summary lines are skipped', () => {
    const path = join(dir, 'lme.jsonl');
    writeFileSync(path, [
      { question_id: 'q1', question_type: 'temporal-reasoning', question: 'When?', answer: 'May', hypothesis: 'In May', judge_correct: true, judge_model: 'gpt-4o-2024-08-06' },
      { question_id: 'q2', question_type: 'multi-session', question: 'Who?', answer: 42, hypothesis: '41', judge_correct: false, judge_model: 'gpt-4o-2024-08-06' },
      { question_id: 'q3', question: 'x', answer: 'y', hypothesis: 'z', judge_error: 'timeout' },
      { question_id: 'q4', question: 'x', answer: 'y', hypothesis: 'z', judge_skipped: 'budget' },
      { question_id: 'q5', question: 'x', answer: 'y', hypothesis: 'z' },
      { kind: 'by_type_summary', schema_version: 2 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const { items, skipped } = loadJudgeItems('longmemeval', path);
    expect(items.map((i) => [i.id, i.reference, i.slice, i.label_source])).toEqual([
      ['q1', true, 'temporal-reasoning', 'llm:gpt-4o-2024-08-06'],
      ['q2', false, 'multi-session', 'llm:gpt-4o-2024-08-06'],
    ]);
    expect(skipped).toEqual({ judge_error: 1, judge_skipped: 1, unjudged: 1 });
    expect(items[1]!.question.inputs!.answer!.text).toBe('42');
    expect(items[0]!.question.instructions).toContain('`hypothesis`');
    expect(items[0]!.question.inputs!.hypothesis!.transcript_ref).toBe('judge-agreement:q1');
  });

  test('grounding: sources array, transcript and transcript_path; verdict spellings; label_source kept', () => {
    writeFileSync(join(dir, 't.txt'), 'user: alice-example moved to acme-example in May');
    const path = join(dir, 'grounding.jsonl');
    writeFileSync(path, [
      { id: 'g1', page: 'people/alice-example', claim: 'alice-example moved to acme-example', sources: ['a', 'b'], label: 'supported', label_source: 'llm:claude-sonnet-4-6' },
      { id: 'g2', page: 'people/alice-example', claim: 'alice-example left in June', transcript: 'no dates here', label: 'quarantine' },
      { id: 'g3', page: 'p', claim: 'moved in May', transcript_path: 't.txt', label: false },
      { id: 'g4', page: 'p', claim: 'x', sources: 'y', label: 'maybe' },
      { id: 'g5', page: 'p', claim: 'x', label: true },
    ].map((r) => JSON.stringify(r)).join('\n'));
    const { items, skipped } = loadJudgeItems('grounding', path);
    expect(items.map((i) => [i.id, i.reference, i.label_source])).toEqual([
      ['g1', true, 'llm:claude-sonnet-4-6'], ['g2', false, 'llm:unknown'], ['g3', false, 'llm:unknown'],
    ]);
    expect(items[0]!.question.inputs!.sources!.text).toBe('a\n---\nb');
    expect(items[2]!.question.inputs!.sources!.text).toContain('acme-example');
    expect(skipped).toEqual({ no_label: 1, no_claim_or_sources: 1 });
  });
});
