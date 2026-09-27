/**
 * Regression: `runValidationGate` must SURFACE errors that make the whole
 * gate meaningless, not swallow them as score=0.
 *
 * The bug the SkillOpt real-LLM eval surfaced: a Haiku run with `--max-cost`
 * hit `BudgetTracker` no_pricing on the FIRST chat() of every rollout, the
 * error threw before any network call, and `runWithLimit` caught it as a
 * `{ok:false}` settled item which the gate turned into `median:0`. Result: the
 * whole gate reported a vacuous `selScore:0` in milliseconds with zero LLM
 * calls — a pricing crash masquerading as a real "0/N" measurement. The fix
 * re-throws any MUST_ABORT-class error so the caller aborts loudly.
 *
 * #4741 widened the same rule structurally: when EVERY task in a gate fails
 * (a dead provider — e.g. a logged-out claude-cli child — is a plain
 * non-tagged error), or EVERY rollout carries a judge_error (dead judge
 * provider), the gate throws instead of scoring the run 0.000 and letting the
 * orchestrator end with a plausible-looking `no_improvement`. Partial failure
 * keeps the pessimistic per-task 0 (fail-open for scoring noise).
 */
import { describe, test, expect } from 'bun:test';
import {
  runValidationGate,
  scoreSkillOnTasks,
  SKILLOPT_ALL_ROLLOUTS_FAILED,
  SKILLOPT_ALL_JUDGE_ERRORS,
} from '../../src/core/skillopt/validate-gate.ts';
import { ClaudeCliProcessError } from '../../src/core/ai/providers/claude-cli-language-model.ts';
import type { BenchmarkTask, ScoredRollout, Trajectory } from '../../src/core/skillopt/types.ts';
import type { RolloutOpts } from '../../src/core/skillopt/rollout.ts';

const TASKS: BenchmarkTask[] = [
  { task_id: 't1', task: 'do a thing', judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'x' }] } } as never,
  { task_id: 't2', task: 'do another', judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'y' }] } } as never,
];

function budgetExhausted(): Error {
  const e = new Error('no pricing entry for model "anthropic:claude-haiku-4-5" (kind=chat)');
  (e as { tag?: string }).tag = 'BUDGET_EXHAUSTED';
  return e;
}

const LOGGED_OUT = 'claude-cli reported error: Not logged in · Please run /login';

const okTrajectory = (final_text: string): Trajectory =>
  ({ final_text, tool_calls: [], turns: 1 }) as never;

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

  test('a PARTIAL (non-abort) rollout failure still scores that task 0 — fail-open preserved', async () => {
    // t1 throws a plain error (no .tag → not must-abort); t2 completes and
    // passes its contains-'y' check. Pessimistic mean = (0 + 1) / 2.
    const flakyRollout = (async (o: RolloutOpts) => {
      if (o.task.task_id === 't1') throw new Error('transient judge hiccup');
      return okTrajectory('y');
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
    expect(gate.selScore).toBe(0.5);
    expect(gate.scoredRollouts).toHaveLength(1);
    expect(gate.perTaskMedians.find((r) => r.task_id === 't1')?.median).toBe(0);
  });
});

describe('#4741 — a 100%-failed gate is an error, not a 0.000 measurement', () => {
  const loggedOutRollout = (async () => {
    throw new ClaudeCliProcessError(LOGGED_OUT);
  }) as never;

  test('every task failing with a non-abort error throws skillopt_all_rollouts_failed carrying the first error', async () => {
    await expect(
      runValidationGate({
        engine: {} as never,
        candidateSkillText: 'skill',
        selSet: TASKS,
        bestScore: -1,
        targetModel: 'claude-cli:claude-sonnet-4-6',
        runsPerTask: 1,
        rolloutFn: loggedOutRollout,
      }),
    ).rejects.toThrow(new RegExp(`${SKILLOPT_ALL_ROLLOUTS_FAILED}.*Not logged in`));
  });

  test('scoreSkillOnTasks propagates the all-failed error too', async () => {
    await expect(
      scoreSkillOnTasks({
        engine: {} as never,
        skillText: 'skill',
        tasks: TASKS,
        targetModel: 'claude-cli:claude-sonnet-4-6',
        runsPerTask: 1,
        rolloutFn: loggedOutRollout,
      }),
    ).rejects.toThrow(new RegExp(`${SKILLOPT_ALL_ROLLOUTS_FAILED}.*Not logged in`));
  });

  test('every rollout carrying a judge_error throws skillopt_all_judge_errors', async () => {
    const deadJudge = (async (trajectory: Trajectory): Promise<ScoredRollout> => ({
      trajectory,
      score: 0,
      judge_error: 'llm_call_failed: 401 Unauthorized',
    })) as never;
    await expect(
      runValidationGate({
        engine: {} as never,
        candidateSkillText: 'skill',
        selSet: TASKS,
        bestScore: -1,
        targetModel: 'anthropic:claude-haiku-4-5',
        judgeModel: 'anthropic:claude-sonnet-4-6',
        runsPerTask: 1,
        rolloutFn: (async () => okTrajectory('x y')) as never,
        scoreFn: deadJudge,
      }),
    ).rejects.toThrow(new RegExp(`${SKILLOPT_ALL_JUDGE_ERRORS}.*401 Unauthorized`));
  });

  test('one judge_error out of two rollouts resolves (partial judge failure stays fail-open)', async () => {
    const flakyJudge = (async (trajectory: Trajectory, judge: BenchmarkTask['judge']): Promise<ScoredRollout> => {
      const arg = (judge as { checks: Array<{ arg: string }> }).checks[0]!.arg;
      return arg === 'x'
        ? { trajectory, score: 0, judge_error: 'llm_call_failed: timeout' }
        : { trajectory, score: 1 };
    }) as never;
    const gate = await runValidationGate({
      engine: {} as never,
      candidateSkillText: 'skill',
      selSet: TASKS,
      bestScore: -1,
      targetModel: 'anthropic:claude-haiku-4-5',
      judgeModel: 'anthropic:claude-sonnet-4-6',
      runsPerTask: 1,
      rolloutFn: (async () => okTrajectory('x y')) as never,
      scoreFn: flakyJudge,
    });
    expect(gate.selScore).toBe(0.5);
    expect(gate.scoredRollouts).toHaveLength(2);
  });
});
