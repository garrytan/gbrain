/**
 * Regression: `runValidationGate` must SURFACE must-abort errors (budget
 * exhaustion / no-pricing), not swallow them as score=0.
 *
 * The bug the SkillOpt real-LLM eval surfaced: a Haiku run with `--max-cost`
 * hit `BudgetTracker` no_pricing on the FIRST chat() of every rollout, the
 * error threw before any network call, and `runWithLimit` caught it as a
 * `{ok:false}` settled item which the gate turned into `median:0`. Result: the
 * whole gate reported a vacuous `selScore:0` in milliseconds with zero LLM
 * calls — a pricing crash masquerading as a real "0/N" measurement. The fix
 * re-throws any MUST_ABORT-class error so the caller aborts loudly.
 */
import { describe, test, expect } from 'bun:test';
import { runValidationGate, scoreSkillOnTasks } from '../../src/core/skillopt/validate-gate.ts';
import type { BenchmarkTask } from '../../src/core/skillopt/types.ts';

const TASKS: BenchmarkTask[] = [
  { task_id: 't1', task: 'do a thing', judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'x' }] } } as never,
  { task_id: 't2', task: 'do another', judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'y' }] } } as never,
];

function budgetExhausted(): Error {
  const e = new Error('no pricing entry for model "anthropic:claude-haiku-4-5" (kind=chat)');
  (e as { tag?: string }).tag = 'BUDGET_EXHAUSTED';
  return e;
}

describe('runValidationGate — must-abort errors surface', () => {
  test('a BUDGET_EXHAUSTED rollout error is re-thrown, not scored 0', async () => {
    const throwingRollout = (async () => {
      throw budgetExhausted();
    }) as never;
    await expect(
      runValidationGate({
        engine: {} as never,
        candidateSkillText: 'skill',
        selSet: TASKS,
        bestScore: -1,
        targetModel: 'anthropic:claude-haiku-4-5',
        runsPerTask: 1,
        rolloutFn: throwingRollout,
      }),
    ).rejects.toThrow(/no pricing entry/);
  });

  test('scoreSkillOnTasks propagates the abort too (does not return a vacuous 0)', async () => {
    const throwingRollout = (async () => {
      throw budgetExhausted();
    }) as never;
    await expect(
      scoreSkillOnTasks({
        engine: {} as never,
        skillText: 'skill',
        tasks: TASKS,
        targetModel: 'anthropic:claude-haiku-4-5',
        runsPerTask: 1,
        rolloutFn: throwingRollout,
      }),
    ).rejects.toThrow(/no pricing entry/);
  });

  test('an ordinary (non-abort) rollout error still scores 0 — fail-open preserved', async () => {
    const flakyRollout = (async () => {
      throw new Error('transient judge hiccup'); // no .tag → not must-abort
    }) as never;
    const gate = await runValidationGate({
      engine: {} as never,
      candidateSkillText: 'skill',
      selSet: TASKS,
      bestScore: -1,
      targetModel: 'anthropic:claude-haiku-4-5',
      runsPerTask: 1,
      rolloutFn: flakyRollout,
    });
    expect(gate.selScore).toBe(0);
    expect(gate.scoredRollouts).toHaveLength(0);
  });
});
