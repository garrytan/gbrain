/**
 * #4119 skillopt hardening — two code-level pieces:
 *
 * 1. In-rollout-loop deadline: `deadlineMs` is observed INSIDE the gate's
 *    rollout loop (before every individual rollout), and a breach surfaces
 *    as `skillopt_runtime_exceeded` — never swallowed as a 0-score task.
 *    Pre-fix the orchestrator only checked the wall clock between steps, so
 *    a long batch blew past --max-runtime by a whole gate's worth of
 *    rollouts.
 *
 * 2. Opt-in hermetic config for claude-cli children: resolveHermeticConfigDir
 *    maps GBRAIN_CLAUDE_CLI_HERMETIC_CONFIG to the child's CLAUDE_CONFIG_DIR
 *    (off by default — the config dir carries OAuth credentials on non-macOS
 *    installs, so hermetic mode is a deliberate choice, never a default).
 */
import { describe, test, expect } from 'bun:test';
import { existsSync } from 'fs';
import {
  runValidationGate,
  scoreSkillOnTasks,
  SKILLOPT_RUNTIME_EXCEEDED,
} from '../../src/core/skillopt/validate-gate.ts';
import { resolveHermeticConfigDir } from '../../src/core/ai/providers/claude-cli-language-model.ts';
import type { BenchmarkTask } from '../../src/core/skillopt/types.ts';

const TASKS: BenchmarkTask[] = [
  { task_id: 't1', task: 'do a thing', judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'x' }] } } as never,
  { task_id: 't2', task: 'do another', judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'y' }] } } as never,
];

const okRollout = (async () => ({
  final_text: 'x y',
  tool_calls: [],
  turns: 1,
})) as never;

describe('#4119 — in-rollout-loop deadline', () => {
  test('an already-expired deadline aborts the gate before any rollout', async () => {
    let rolloutsRun = 0;
    const countingRollout = (async () => {
      rolloutsRun += 1;
      return { final_text: 'x', tool_calls: [], turns: 1 };
    }) as never;
    await expect(
      runValidationGate({
        engine: {} as never,
        candidateSkillText: 'skill',
        selSet: TASKS,
        bestScore: -1,
        targetModel: 'anthropic:claude-haiku-4-5',
        runsPerTask: 1,
        deadlineMs: Date.now() - 1_000,
        rolloutFn: countingRollout,
      }),
    ).rejects.toThrow(SKILLOPT_RUNTIME_EXCEEDED);
    expect(rolloutsRun).toBe(0);
  });

  test('scoreSkillOnTasks threads the deadline too', async () => {
    await expect(
      scoreSkillOnTasks({
        engine: {} as never,
        skillText: 'skill',
        tasks: TASKS,
        targetModel: 'anthropic:claude-haiku-4-5',
        runsPerTask: 1,
        deadlineMs: Date.now() - 1_000,
        rolloutFn: okRollout,
      }),
    ).rejects.toThrow(SKILLOPT_RUNTIME_EXCEEDED);
  });

  test('a future deadline leaves the gate untouched', async () => {
    const gate = await runValidationGate({
      engine: {} as never,
      candidateSkillText: 'skill',
      selSet: TASKS,
      bestScore: -1,
      targetModel: 'anthropic:claude-haiku-4-5',
      runsPerTask: 1,
      deadlineMs: Date.now() + 60_000,
      rolloutFn: okRollout,
    });
    expect(gate.perTaskMedians.length).toBe(2);
  });

  test('no deadlineMs → no deadline behavior change (back-compat)', async () => {
    const gate = await runValidationGate({
      engine: {} as never,
      candidateSkillText: 'skill',
      selSet: TASKS,
      bestScore: -1,
      targetModel: 'anthropic:claude-haiku-4-5',
      runsPerTask: 1,
      rolloutFn: okRollout,
    });
    expect(gate.perTaskMedians.length).toBe(2);
  });
});

describe('#4119 — resolveHermeticConfigDir (opt-in)', () => {
  test('unset / 0 / false → null (child inherits the real config dir)', () => {
    expect(resolveHermeticConfigDir(undefined)).toBeNull();
    expect(resolveHermeticConfigDir('')).toBeNull();
    expect(resolveHermeticConfigDir('0')).toBeNull();
    expect(resolveHermeticConfigDir('false')).toBeNull();
    expect(resolveHermeticConfigDir('FALSE')).toBeNull();
  });

  test('1/true → per-process isolated dir, created on demand', () => {
    const dir = resolveHermeticConfigDir('1');
    expect(dir).not.toBeNull();
    expect(dir).toContain('gbrain-claude-cli-config-');
    expect(existsSync(dir!)).toBe(true);
    // Stable across calls (same process → same dir).
    expect(resolveHermeticConfigDir('true')).toBe(dir);
  });

  test('an explicit path is used verbatim', () => {
    expect(resolveHermeticConfigDir('/tmp/my-seeded-claude-config')).toBe(
      '/tmp/my-seeded-claude-config',
    );
  });
});
