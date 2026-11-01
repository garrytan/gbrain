/**
 * B1 benchmark hooks (GBRA-274): the batch rollout hook contract, explicit task
 * lists, per-task scores, rollout tool declarations and train-only criteria.
 * Pure: no engine work, no models.
 */

import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runValidationGate, scoreSkillPerTask } from '../../src/core/skillopt/validate-gate.ts';
import { isSkilloptMustAbort, SKILLOPT_HOOK_INFRA_ERROR, SKILLOPT_RUNTIME_EXCEEDED } from '../../src/core/skillopt/must-abort.ts';
import { loadRunTasks } from '../../src/core/skillopt/benchmark.ts';
import { describeJudges } from '../../src/core/skillopt/reflect.ts';
import { READ_ONLY_BRAIN_TOOLS, rolloutToolsForSkill } from '../../src/core/skillopt/rollout.ts';
import type { BenchmarkTask, RolloutBatchHook, RolloutBatchRequest, ScoredRollout } from '../../src/core/skillopt/types.ts';
import * as skillopt from '../../src/core/skillopt/index.ts';
import { getCurrentBudgetTracker, withBudgetTracker } from '../../src/core/ai/gateway.ts';
import { BudgetTracker } from '../../src/core/budget/budget-tracker.ts';

const engine = {} as BrainEngine;
const task = (id: string, arg = 'x'): BenchmarkTask => ({ task_id: id, task: `do ${id}`, judge: { kind: 'rule', checks: [{ op: 'contains', arg }] } } as BenchmarkTask);
const tasks = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => task(`${prefix}-${i + 1}`));
const row = (score: number): ScoredRollout => ({ score, trajectory: { task_id: '', task: '', final_text: '', tool_calls: [], turns: 1, stop_reason: 'end', duration_ms: 0,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } } } as ScoredRollout);

test('B1.1: the harness surface is exported from the skillopt index', () => {
  for (const name of ['runSkillOpt', 'runRollout', 'scoreTrajectory', 'scoreSkillPerTask', 'scoreSkillOnTasks', 'rolloutToolsForSkill', 'describeJudges']) {
    expect(typeof (skillopt as Record<string, unknown>)[name]).toBe('function');
  }
  expect(skillopt.READ_ONLY_BRAIN_TOOLS).toBe(READ_ONLY_BRAIN_TOOLS);
});

describe('rollout hook (B1.3)', () => {
  test('one call for the whole batch, per-task medians and the request labels', async () => {
    const calls: RolloutBatchRequest[] = [];
    const hook: RolloutBatchHook = async (req) => { calls.push(req); return req.tasks.map((_, i) => [row(i % 2), row(1), row(0)]); };
    const res = await scoreSkillPerTask({ engine, skillText: 'SKILL', tasks: tasks('s', 4), targetModel: 'm', rolloutHook: hook });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ phase: 'test', skillText: 'SKILL', runsPerTask: 3, epoch: 0, step: 0 });
    expect(calls[0]!.skillSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.perTask.map((p) => p.median)).toEqual([0, 1, 0, 1]);
    expect(res.score).toBe(0.5);
  });

  test.each([
    ['too few rows', (req: RolloutBatchRequest) => req.tasks.slice(1).map(() => [row(1), row(1), row(1)])],
    ['too few runs', (req: RolloutBatchRequest) => req.tasks.map(() => [row(1)])],
    ['not an array', () => ({}) as unknown as ScoredRollout[][]],
    ['a string score', (req: RolloutBatchRequest) => req.tasks.map(() => [row(1), row(1), { ...row(1), score: '0.9' } as unknown as ScoredRollout])],
    ['a NaN score', (req: RolloutBatchRequest) => req.tasks.map(() => [row(1), row(1), row(Number.NaN)])],
    ['a score above 1', (req: RolloutBatchRequest) => req.tasks.map(() => [row(7), row(7), row(7)])],
  ])('a malformed batch (%s) is an infra error that aborts, never a score', async (_name, reply) => {
    const hook: RolloutBatchHook = async (req) => reply(req);
    const err = await runValidationGate({ engine, candidateSkillText: 'S', selSet: tasks('s', 5), bestScore: 0, targetModel: 'm', rolloutHook: hook })
      .then(() => null, (e) => e);
    expect(String(err?.message)).toContain(SKILLOPT_HOOK_INFRA_ERROR);
    expect(isSkilloptMustAbort(err)).toBe(true);
  });

  test('the hook runs outside the run budget, so in-process rollouts are never billed to the optimizer cap', async () => {
    const seen: Array<BudgetTracker | null> = [];
    const hook: RolloutBatchHook = async (req) => {
      seen.push(getCurrentBudgetTracker());
      await Promise.resolve();
      seen.push(getCurrentBudgetTracker());
      return req.tasks.map(() => [row(1), row(1), row(1)]);
    };
    const tracker = new BudgetTracker({ maxCostUsd: 1, label: 'skillopt:test' });
    await withBudgetTracker(tracker, () => scoreSkillPerTask({ engine, skillText: 'S', tasks: tasks('s', 2), targetModel: 'm', rolloutHook: hook }));
    expect(seen).toEqual([null, null]);
  });

  test('a batch still running at the runtime deadline aborts the run, and the hook is signalled', async () => {
    let signal: AbortSignal | undefined;
    const hook: RolloutBatchHook = (req, s) => { signal = s; return new Promise(() => {}); };
    const err = await runValidationGate({ engine, candidateSkillText: 'S', selSet: tasks('s', 5), bestScore: 0, targetModel: 'm', rolloutHook: hook, deadlineMs: Date.now() + 50 })
      .then(() => null, (e) => e);
    expect(String(err?.message)).toContain(SKILLOPT_RUNTIME_EXCEEDED);
    expect(isSkilloptMustAbort(err)).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  test('a batch answered after the runtime deadline is not a score', async () => {
    const hook: RolloutBatchHook = async (req) => { await new Promise((r) => setTimeout(r, 30)); return req.tasks.map(() => [row(1), row(1), row(1)]); };
    const deadlineMs = Date.now() + 10;
    const err = await runValidationGate({ engine, candidateSkillText: 'S', selSet: tasks('s', 5), bestScore: 0, targetModel: 'm', rolloutHook: hook, deadlineMs })
      .then(() => null, (e) => e);
    expect(String(err?.message)).toContain(SKILLOPT_RUNTIME_EXCEEDED);
  });

  test('a train_forward row without a trajectory is an infra error', async () => {
    const hook: RolloutBatchHook = async (req) => req.tasks.map(() => [{ score: 1 } as ScoredRollout]);
    const err = await scoreSkillPerTask({ engine, skillText: 'S', tasks: tasks('t', 2), targetModel: 'm', runsPerTask: 1, phase: 'train_forward', rolloutHook: hook })
      .then(() => null, (e) => e);
    expect(String(err?.message)).toContain(SKILLOPT_HOOK_INFRA_ERROR);
  });
});

describe('explicit task lists (B1.2)', () => {
  test('lists are used as given, with a stable sha', () => {
    const t = { train: tasks('t', 2), sel: tasks('s', 5) };
    const a = loadRunTasks({ tasks: t });
    expect(a.split.train.map((x) => x.task_id)).toEqual(['t-1', 't-2']);
    expect(a.split.sel).toHaveLength(5);
    expect(a.split.test).toHaveLength(0);
    expect(a.bench.benchmark_sha8).toBe(loadRunTasks({ tasks: t }).bench.benchmark_sha8);
    expect(a.bench.benchmark_sha8).not.toBe(loadRunTasks({ tasks: { ...t, train: tasks('t', 3) } }).bench.benchmark_sha8);
  });
  test('a task id in two lists, an empty train list or a small sel list is refused', () => {
    const code = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return (e as { envelope?: { code: string } }).envelope?.code; } };
    expect(code(() => loadRunTasks({ tasks: { train: [task('s-1')], sel: tasks('s', 5) } }))).toBe('benchmark_duplicate_task_id');
    expect(code(() => loadRunTasks({ tasks: { train: [], sel: tasks('s', 5) } }))).toBe('benchmark_empty');
    expect(code(() => loadRunTasks({ tasks: { train: tasks('t', 2), sel: tasks('s', 4) } }))).toBe('d_sel_too_small');
  });
});

describe('criteria (defect 3 / B1.4)', () => {
  test('a check every task shares is verbatim; a per-task answer is described, never quoted', () => {
    const ts = ['a', 'b', 'c'].map((id) => ({ judge: { kind: 'rule' as const, checks: [{ op: 'contains', arg: `GOLD-${id}` }, { op: 'section_present', arg: 'Sources' }] } }));
    const text = describeJudges(ts as never);
    expect(text).toContain('"Sources"');
    expect(text).not.toContain('GOLD-');
    expect(text.split('\n')).toHaveLength(2);
  });
  test('a single task never counts as shared', () => {
    expect(describeJudges([{ judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'GOLD-1' }] } }] as never)).not.toContain('GOLD-1');
  });
  test('per-task LLM rubrics are not quoted', () => {
    const text = describeJudges([{ judge: { kind: 'llm', rubric: 'RUBRIC-A' } }, { judge: { kind: 'llm', rubric: 'RUBRIC-B' } }] as never);
    expect(text).not.toContain('RUBRIC-');
  });
});

describe('rollout tools (B1.5)', () => {
  const skill = (tools: string) => `---\nname: s\ntools: [${tools}]\n---\n# S\n`;
  test('the base set never offers a write', () => {
    expect(READ_ONLY_BRAIN_TOOLS.has('put_page')).toBe(false);
    expect(READ_ONLY_BRAIN_TOOLS.has('add_timeline_entry')).toBe(false);
  });
  test('a skill adds reviewed read ops by declaring them; anything else it names is ignored', () => {
    const got = rolloutToolsForSkill(skill('recall, get_timeline, put_page, add_timeline_entry, advisor, context_pack'));
    expect(got.has('recall')).toBe(true);
    expect(got.has('get_timeline')).toBe(true);
    for (const n of ['put_page', 'add_timeline_entry', 'advisor', 'context_pack']) expect(got.has(n)).toBe(false);
    expect(rolloutToolsForSkill(skill('')).size).toBe(READ_ONLY_BRAIN_TOOLS.size);
  });
});
