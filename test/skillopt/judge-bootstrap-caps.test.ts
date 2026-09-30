/**
 * #5584 — judge + bootstrap output caps, truncation handling and must-abort.
 *
 *   - LLM judge: Claude 5 judge sends 8192 (skilloptOutputCap floor), a
 *     non-thinking judge keeps 200; a length-stopped unparseable reply is
 *     `llm_truncated`; BudgetExhausted is rethrown (never a score of 0) and
 *     aborts the gate that is scoring (held-out gates score through the same
 *     path).
 *   - Bootstrap: routing rows and the from-skill call use the thinking floor;
 *     length-stopped routing rows are skipped as `truncated`; the from-skill
 *     reply's cut final line is dropped; exhaustion mid-rows aborts with no
 *     benchmark written.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scoreTrajectory } from '../../src/core/skillopt/score.ts';
import { runValidationGate } from '../../src/core/skillopt/validate-gate.ts';
import { runBootstrap, runBootstrapFromSkill } from '../../src/core/skillopt/bootstrap-benchmark.ts';
import { BudgetExhausted } from '../../src/core/budget/budget-tracker.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import type { BenchmarkTask, Trajectory } from '../../src/core/skillopt/types.ts';

const THINKING = 'anthropic:claude-opus-5';
const PLAIN = 'anthropic:claude-sonnet-4-6';
const SKILL = 'widget-example';

type AnyChat = (opts: ChatOpts) => Promise<ChatResult>;

function reply(text: string, stopReason: ChatResult['stopReason'] = 'end'): ChatResult {
  return {
    text, blocks: [{ type: 'text', text }], stopReason,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: PLAIN, providerId: 'anthropic',
  };
}

function recorder(fn: (opts: ChatOpts, n: number) => ChatResult): { chatFn: AnyChat; calls: ChatOpts[] } {
  const calls: ChatOpts[] = [];
  return { calls, chatFn: async (opts) => { calls.push(opts); return fn(opts, calls.length); } };
}

const exhausted = () => new BudgetExhausted('skillopt:x: projected cost $2 exceeds --max-cost $1.00', { reason: 'cost', spent: 0.5, cap: 1 });

const trajectory = { task_id: 't', task: 'do', final_text: 'out', tool_calls: [], turns: 1 } as unknown as Trajectory;
const LLM_JUDGE = { kind: 'llm' as const, rubric: 'is it good?' };

describe('LLM judge', () => {
  test('Claude 5 judge sends 8192; non-thinking judge keeps 200', async () => {
    for (const [model, expected] of [[THINKING, 8192], [PLAIN, 200]] as const) {
      const r = recorder(() => reply('{"score": 1, "rationale": "ok"}'));
      await scoreTrajectory(trajectory, LLM_JUDGE, { judgeModel: model, chatFn: r.chatFn as never });
      expect(r.calls[0]!.maxTokens).toBe(expected);
    }
  });

  test('length stop with unparseable text -> llm_truncated; plain garbage stays llm_parse_failed', async () => {
    const cut = recorder(() => reply('{"score": 0.', 'length'));
    const a = await scoreTrajectory(trajectory, LLM_JUDGE, { judgeModel: THINKING, chatFn: cut.chatFn as never });
    expect(a).toMatchObject({ score: 0, judge_error: 'llm_truncated' });
    const junk = recorder(() => reply('no json here'));
    const b = await scoreTrajectory(trajectory, LLM_JUDGE, { judgeModel: THINKING, chatFn: junk.chatFn as never });
    expect(b.judge_error).toBe('llm_parse_failed');
  });

  test('BudgetExhausted is rethrown, not scored 0; other errors still fail open', async () => {
    const boom = recorder(() => { throw exhausted(); });
    await expect(scoreTrajectory(trajectory, LLM_JUDGE, { judgeModel: PLAIN, chatFn: boom.chatFn as never })).rejects.toBeInstanceOf(BudgetExhausted);
    const flaky = recorder(() => { throw new Error('503'); });
    const res = await scoreTrajectory(trajectory, LLM_JUDGE, { judgeModel: PLAIN, chatFn: flaky.chatFn as never });
    expect(res).toMatchObject({ score: 0, judge_error: 'llm_call_failed: 503' });
  });

  test('exhaustion during judging aborts the gate (the held-out gate scores through this path)', async () => {
    const tasks: BenchmarkTask[] = [
      { task_id: 'a', task: 'a', judge: LLM_JUDGE },
      { task_id: 'b', task: 'b', judge: LLM_JUDGE },
    ];
    let n = 0;
    const judgeChat: AnyChat = async () => { n += 1; if (n === 2) throw exhausted(); return reply('{"score": 1}'); };
    await expect(runValidationGate({
      engine: {} as never,
      candidateSkillText: 'skill',
      selSet: tasks,
      bestScore: -1,
      targetModel: PLAIN,
      judgeModel: PLAIN,
      runsPerTask: 1,
      concurrency: 1,
      rolloutFn: (async () => trajectory) as never,
      scoreFn: ((t: Trajectory, j: BenchmarkTask['judge'], o: { judgeModel?: string }) =>
        scoreTrajectory(t, j, { ...o, chatFn: judgeChat as never })) as never,
    })).rejects.toBeInstanceOf(BudgetExhausted);
  });
});

describe('bootstrap generators', () => {
  let skillsDir: string;
  beforeEach(() => {
    skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-caps-'));
    fs.mkdirSync(path.join(skillsDir, SKILL), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, SKILL, 'SKILL.md'), '# Widget\n\nMakes a report.\n');
    const rows = [1, 2, 3].map((i) => JSON.stringify({ intent: `make report ${i}`, expected_skill: SKILL }));
    fs.writeFileSync(path.join(skillsDir, SKILL, 'routing-eval.jsonl'), rows.join('\n') + '\n');
  });
  afterEach(() => { fs.rmSync(skillsDir, { recursive: true, force: true }); });

  const benchPath = () => path.join(skillsDir, SKILL, 'skillopt-benchmark.jsonl');
  const CHECKS = '{"checks": [{"op": "contains", "arg": "Summary"}, {"op": "max_chars", "arg": 4000}]}';

  test('routing rows: thinking floor 8192 vs site cap 500; length-stopped rows skipped as truncated', async () => {
    const plain = recorder(() => reply(CHECKS));
    await runBootstrap({ skillsDir, skillName: SKILL, optimizerModel: PLAIN, chatFn: plain.chatFn as never });
    expect(plain.calls.map((c) => c.maxTokens)).toEqual([500, 500, 500]);

    const stderr: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => { stderr.push(String(c)); return true; }) as typeof process.stderr.write;
    try {
      const mixed = recorder((_o, n) => (n === 2 ? reply(CHECKS, 'length') : reply(CHECKS)));
      const res = await runBootstrap({ skillsDir, skillName: SKILL, optimizerModel: THINKING, force: true, chatFn: mixed.chatFn as never });
      expect(mixed.calls.map((c) => c.maxTokens)).toEqual([8192, 8192, 8192]);
      expect(res).toMatchObject({ rowsGenerated: 2, rowsSkipped: 1 });
      expect(stderr.join('')).toContain('bootstrap row 2 skipped: truncated');
    } finally {
      process.stderr.write = realWrite;
    }
  });

  test('routing rows: exhaustion mid-rows aborts and writes no benchmark', async () => {
    const r = recorder((_o, n) => { if (n === 2) throw exhausted(); return reply(CHECKS); });
    await expect(runBootstrap({ skillsDir, skillName: SKILL, optimizerModel: PLAIN, chatFn: r.chatFn as never })).rejects.toBeInstanceOf(BudgetExhausted);
    expect(fs.existsSync(benchPath())).toBe(false);
  });

  test('from-skill: thinking floor applies; a length-stopped reply drops its cut final line', async () => {
    const line = (i: number) => JSON.stringify({ task: `task ${i}`, checks: [{ op: 'contains', arg: `a${i}` }, { op: 'contains', arg: `b${i}` }] });
    const text = [line(1), line(2), line(3)].join('\n');
    const r = recorder(() => reply(text, 'length'));
    const res = await runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: THINKING, taskCount: 5, chatFn: r.chatFn as never });
    expect(r.calls[0]!.maxTokens).toBe(8192);
    expect(res).toMatchObject({ rowsGenerated: 2, rowsSkipped: 1 });

    const plain = recorder(() => reply(text));
    await runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: PLAIN, taskCount: 5, force: true, chatFn: plain.chatFn as never });
    expect(plain.calls[0]!.maxTokens).toBe(4000);
  });
});
