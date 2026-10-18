/**
 * Keyless check of the W6 take-grading eval instrument (evals/take-grading/).
 *
 * Protects: the committed fixtures match their generator; the set counts the
 * preregistration fixes, placeholder names only, no claim repeated across or
 * within splits, and the dates each set promises (pre-horizon evidence
 * between the claim and the horizon, outcome evidence after it, pre-claim
 * evidence before the claim); the production evidence block (no truncation,
 * the no-evidence note, the before-the-claim annotation); the grader's truth
 * table (applied means not unresolvable and at or above the production
 * threshold; every applied verdict on a gold-unresolvable fixture is wrong);
 * the Clopper-Pearson bound at the 299 / 473 boundaries; the decision rule
 * and the ranking. Fails when: a fixture is hand-edited without
 * regenerating, a set drifts off its shape, or the grader or the bound
 * changes meaning. It guards the instrument, not the score: the live run
 * spends tokens and is never part of CI.
 * Why new: the eval is new with W6.
 * Seams: none (pure functions over the fixtures; no gateway, no brain).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GRADE_TAKES_AUTO_RESOLVE_THRESHOLD } from '../src/core/cycle/grade-takes.ts';
import { SET_COUNTS, type Fixture } from '../evals/take-grading/cases.ts';
import { checkFixtures, evidenceBlock } from '../evals/take-grading/check.ts';
import { fixturesJsonl } from '../evals/take-grading/generate-fixtures.ts';
import { buildReport, renderMarkdown } from '../evals/take-grading/report.ts';
import { cpUpper, grade, rank, summarize, type ResultRow } from '../evals/take-grading/score.ts';

const text = readFileSync(join(import.meta.dir, '..', 'evals/take-grading/fixtures.jsonl'), 'utf8');
const fixtures: Fixture[] = text.trim().split('\n').map(line => JSON.parse(line));

describe('fixtures', () => {
  test('match the generator (regenerate with bun evals/take-grading/generate-fixtures.ts)', () => {
    expect(text).toBe(fixturesJsonl());
  });

  test('pass every instrument check, with the preregistered counts', () => {
    expect(checkFixtures(fixtures)).toEqual([]);
    const total = (split: 'dev' | 'counted') => Object.values(SET_COUNTS[split]).reduce((s, n) => s + n, 0);
    expect(fixtures.filter(f => f.split === 'counted').length).toBe(total('counted'));
    expect(fixtures.filter(f => f.split === 'dev').length).toBe(total('dev'));
    expect(fixtures.filter(f => f.split === 'counted' && f.rule).length).toBe(750);
    expect(fixtures.filter(f => f.split === 'counted' && f.rule && f.gold !== 'unresolvable').length).toBe(500);
  });

  test('the judge sees the production evidence block', () => {
    const none = fixtures.find(f => f.set === 'no_evidence')!;
    expect(evidenceBlock(none)).toStartWith('No evidence found in the brain for this claim');
    const preClaim = fixtures.find(f => f.set === 'pre_claim')!;
    expect(evidenceBlock(preClaim)).toContain('(dated BEFORE the claim — context only, not outcome evidence)');
    const block = evidenceBlock(fixtures.find(f => f.set === 'resolved_incorrect')!);
    expect(block).not.toContain('decisive');
    expect(block).toContain('(dated after the claim)');
  });
});

describe('grading and the decision rule', () => {
  const t = GRADE_TAKES_AUTO_RESOLVE_THRESHOLD;

  test('applied means a resolving verdict at or above the threshold; unresolvable gold makes every applied verdict wrong', () => {
    expect(t).toBe(0.95);
    expect(grade({ gold: 'correct' }, 'correct', 0.95, t)).toEqual({ applied: true, wrong: false });
    expect(grade({ gold: 'correct' }, 'correct', 0.94, t)).toEqual({ applied: false, wrong: false });
    expect(grade({ gold: 'correct' }, 'incorrect', 0.99, t)).toEqual({ applied: true, wrong: true });
    expect(grade({ gold: 'unresolvable' }, 'partial', 0.96, t)).toEqual({ applied: true, wrong: true });
    expect(grade({ gold: 'unresolvable' }, 'unresolvable', 0.99, t)).toEqual({ applied: false, wrong: false });
    expect(grade({ gold: 'correct' }, null, null, t)).toEqual({ applied: false, wrong: false });
  });

  test('the one-sided 95% bound crosses 1% at 299 clean verdicts, or 473 with one error', () => {
    expect(cpUpper(0, 299)).toBeLessThanOrEqual(0.01);
    expect(cpUpper(0, 298)).toBeGreaterThan(0.01);
    expect(cpUpper(1, 473)).toBeLessThanOrEqual(0.01);
    expect(cpUpper(1, 472)).toBeGreaterThan(0.01);
    expect(cpUpper(0, 0)).toBe(1);
  });

  const row = (model: string, id: number, gold: ResultRow['gold'], verdict: ResultRow['verdict'], confidence: number, usd = 0.001): ResultRow => ({
    model, split: 'counted', id: `f${id}`, set: gold === 'unresolvable' ? 'distractor' : 'resolved_correct', cls: 'x', rule: true, gold, world_truth: null,
    verdict, confidence, failure: null, ...grade({ gold }, verdict, confidence, t), input_tokens: 1, output_tokens: 1, usd, latency_ms: 1, reasoning: null, attempts: 1,
  });

  test('a model qualifies only with enough applied verdicts and a bound at or under 1%', () => {
    const clean = Array.from({ length: 300 }, (_, i) => row('a', i, 'correct', 'correct', 0.97));
    const thin = Array.from({ length: 100 }, (_, i) => row('b', i, 'correct', 'correct', 0.97));
    const shy = Array.from({ length: 300 }, (_, i) => row('c', i, 'correct', 'correct', 0.9));
    const leaky = [...Array.from({ length: 300 }, (_, i) => row('d', i, 'correct', 'correct', 0.97)), row('d', 999, 'unresolvable', 'correct', 0.99)];
    const byModel = Object.fromEntries(summarize([...clean, ...thin, ...shy, ...leaky]).map(s => [s.model, s]));
    expect(byModel.a!.qualifies).toBe(true);
    expect(byModel.b!.qualifies).toBe(false);
    expect(byModel.c!).toMatchObject({ applied: 0, qualifies: false, coverage: 0 });
    expect(byModel.d!).toMatchObject({ applied: 301, wrong: 1, qualifies: false, wrong_ids: ['f999'] });
  });

  test('ranking puts qualifying models first, then coverage, then the cheaper', () => {
    const a = Array.from({ length: 300 }, (_, i) => row('a', i, 'correct', 'correct', 0.97, 0.002));
    const e = Array.from({ length: 300 }, (_, i) => row('e', i, 'correct', 'correct', 0.97, 0.001));
    const report = buildReport(summarize([...a, ...e, ...Array.from({ length: 5 }, (_, i) => row('z', i, 'correct', 'correct', 0.99))]), ['x.jsonl']);
    expect(rank(report.models).map(s => s.model)).toEqual(['e', 'a', 'z']);
    expect(report.measured_models).toEqual(['e', 'a']);
    expect(renderMarkdown(report)).toContain('Proposed GRADE_TAKES_MEASURED_MODELS: `e`, `a`.');
  });
});
