import { describe, expect, test } from 'bun:test';
import {
  runValidationGate,
  ValidationGateNoRolloutsError,
} from '../../src/core/skillopt/validate-gate.ts';
import type { BenchmarkTask, ScoredRollout, Trajectory } from '../../src/core/skillopt/types.ts';

const TASKS: BenchmarkTask[] = [
  { task_id: 'task-1', task: 'first task', judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'ok' }] } },
  { task_id: 'task-2', task: 'second task', judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'ok' }] } },
];

function makeTrajectory(task: BenchmarkTask): Trajectory {
  return {
    task_id: task.task_id,
    task: task.task,
    final_text: 'ok',
    tool_calls: [],
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    turns: 1,
    stop_reason: 'end',
    duration_ms: 1,
  };
}

describe('runValidationGate rollout failure handling', () => {
  test('throws a diagnostic error when every rollout fails', async () => {
    let thrown: unknown;
    try {
      await runValidationGate({
        engine: {} as never,
        candidateSkillText: 'skill body',
        selSet: TASKS,
        bestScore: -1,
        targetModel: 'test:model',
        rolloutFn: async () => {
          throw new Error('gateway not configured');
        },
        scoreFn: async () => {
          throw new Error('score should not run');
        },
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ValidationGateNoRolloutsError);
    const err = thrown as ValidationGateNoRolloutsError;
    expect(err.code).toBe('validation_gate_no_rollouts');
    expect(err.failures).toHaveLength(2);
    expect(err.message).toContain('zero scored rollouts');
    expect(err.message).toContain('task-1');
    expect(err.message).toContain('gateway not configured');
  });

  test('keeps pessimistic scoring when only some tasks fail', async () => {
    const result = await runValidationGate({
      engine: {} as never,
      candidateSkillText: 'skill body',
      selSet: TASKS,
      bestScore: -1,
      targetModel: 'test:model',
      runsPerTask: 1,
      rolloutFn: async ({ task }) => {
        if (task.task_id === 'task-2') throw new Error('one bad task');
        return makeTrajectory(task);
      },
      scoreFn: async (trajectory): Promise<ScoredRollout> => ({ trajectory, score: 1 }),
    });

    expect(result.scoredRollouts).toHaveLength(1);
    expect(result.perTaskMedians).toEqual([
      { task_id: 'task-1', median: 1, runs: [1] },
      { task_id: 'task-2', median: 0, runs: [] },
    ]);
    expect(result.selScore).toBe(0.5);
  });
});
