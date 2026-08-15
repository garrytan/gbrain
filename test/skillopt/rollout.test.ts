/**
 * SkillOpt rollout tests (the `toolLoopFn` DI seam — previously zero coverage).
 *
 * Covers: trajectory shape capture, READ_ONLY_BRAIN_TOOLS zero-write invariant,
 * default read-only tool registry (no put_page/submit_job), --write-capture
 * routing to the virtual write registry, and tool-call ordering via the
 * onToolCallStart callback. Hermetic: the toolLoop transport is stubbed, so no
 * LLM calls, no DB, no API keys. Handlers are never executed (the stub returns
 * messages directly), so a `{}`-shaped engine is sufficient.
 */

import { describe, expect, test } from 'bun:test';
import { runRollout, READ_ONLY_BRAIN_TOOLS } from '../../src/core/skillopt/rollout.ts';
import type { BenchmarkTask } from '../../src/core/skillopt/types.ts';

const TASK: BenchmarkTask = {
  task_id: 't1',
  task: 'do the thing',
  judge: { kind: 'rule', checks: [] },
};

/** Build a stubbed toolLoop that records the tool defs it was handed. */
function makeStubLoop(opts: { capturedTools?: Array<{ name: string }>; finalText?: string }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (loopOpts: any) => {
    if (opts.capturedTools) opts.capturedTools.push(...loopOpts.tools);
    return {
      messages: [
        { role: 'user', content: 'do the thing' },
        { role: 'assistant', content: opts.finalText ?? 'done' },
      ],
      totalUsage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      totalTurns: 2,
      stopReason: 'end',
    };
  };
}

describe('rollout — READ_ONLY_BRAIN_TOOLS zero-write invariant', () => {
  test('excludes put_page / submit_job / file_upload, includes a read op', () => {
    expect(READ_ONLY_BRAIN_TOOLS.has('put_page')).toBe(false);
    expect(READ_ONLY_BRAIN_TOOLS.has('submit_job')).toBe(false);
    expect(READ_ONLY_BRAIN_TOOLS.has('file_upload')).toBe(false);
    expect(READ_ONLY_BRAIN_TOOLS.has('search')).toBe(true);
  });
});

describe('rollout — trajectory capture', () => {
  test('returns a Trajectory with the expected shape + threaded usage/stop_reason', async () => {
    const traj = await runRollout({
      engine: {} as never,
      skillText: 'skill body',
      task: TASK,
      targetModel: 'anthropic:claude-sonnet-4-6',
      toolLoopFn: makeStubLoop({ finalText: 'the answer' }) as never,
    });
    expect(traj.task_id).toBe('t1');
    expect(traj.task).toBe('do the thing');
    expect(traj.final_text).toBe('the answer');
    expect(traj.stop_reason).toBe('end');
    expect(traj.turns).toBe(2);
    expect(traj.usage.input_tokens).toBe(10);
    expect(traj.usage.output_tokens).toBe(5);
    expect(typeof traj.duration_ms).toBe('number');
    expect(Array.isArray(traj.tool_calls)).toBe(true);
  });
});

describe('rollout — tool registry routing', () => {
  test('default rollout passes ONLY read-only tools (no write defs)', async () => {
    const capturedTools: Array<{ name: string }> = [];
    await runRollout({
      engine: {} as never,
      skillText: 's',
      task: TASK,
      targetModel: 'm',
      toolLoopFn: makeStubLoop({ capturedTools }) as never,
    });
    const names = capturedTools.map((d) => d.name);
    expect(names).toContain('brain_search');
    expect(names).not.toContain('brain_put_page');
    expect(names).not.toContain('brain_submit_job');
    expect(names).not.toContain('brain_file_upload');
  });

  test('--write-capture routes to the virtual write registry (put_page present, captured not real)', async () => {
    const capturedTools: Array<{ name: string }> = [];
    await runRollout({
      engine: {} as never,
      skillText: 's',
      task: TASK,
      targetModel: 'm',
      writeCapture: true,
      toolLoopFn: makeStubLoop({ capturedTools }) as never,
    });
    const names = capturedTools.map((d) => d.name);
    expect(names).toContain('brain_put_page');
    expect(names).toContain('brain_submit_job');
    expect(names).toContain('brain_file_upload');
  });
});

describe('rollout — tool-call ordering', () => {
  test('onToolCallStart records calls in order with the brain_ prefix stripped', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loop = async (loopOpts: any) => {
      await loopOpts.onToolCallStart?.(0, 0, 0, 'brain_search', { q: 'x' }, 'pc1');
      await loopOpts.onToolCallStart?.(0, 1, 1, 'brain_get_page', { slug: 'y' }, 'pc2');
      return {
        messages: [{ role: 'assistant', content: 'ok' }],
        totalUsage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        totalTurns: 1,
        stopReason: 'end',
      };
    };
    const traj = await runRollout({
      engine: {} as never, skillText: 's', task: TASK, targetModel: 'm', toolLoopFn: loop as never,
    });
    expect(traj.tool_calls).toHaveLength(2);
    expect(traj.tool_calls[0]!.name).toBe('search');
    expect(traj.tool_calls[1]!.name).toBe('get_page');
  });
});
