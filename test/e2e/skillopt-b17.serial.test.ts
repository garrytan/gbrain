/**
 * SkillOpt B1.7: the benchmark interfaces (explicit task lists, a batch
 * rollout hook, receipt counts, a criteria override) backported onto the
 * pre-wave loop at 3ec766c40, with E1 and defects 1-4 left as they were.
 *
 * Hermetic: PGLite in-memory engine, tempdir skill, a stub chat transport for
 * the optimizer and target, rule judges. No API keys, no network.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { withEnv } from '../helpers/with-env.ts';
import { __setChatTransportForTests, type ChatOpts, type ChatResult } from '../../src/core/ai/gateway.ts';
import { runSkillOpt } from '../../src/core/skillopt/orchestrator.ts';
import { loadRejectedBuffer } from '../../src/core/skillopt/rejected-buffer.ts';
import type { BenchmarkTask, EditOp, RolloutBatchRequest, ScoredRollout, SkillOptOpts } from '../../src/core/skillopt/types.ts';

const SKILL = 'wave-skill';
const OPTIMIZER = 'anthropic:claude-opus-4-7';
const TARGET = 'anthropic:claude-sonnet-4-6';
const BASE = `---
name: wave-skill
version: 0.1.0
description: Test skill for the SkillOpt wave.
triggers:
  - "do the wave task"
brain_first: exempt
---

# Wave

Answer the task.

## People
List people.
`;
const SECTIONS = ['People', 'Citations', 'Summary'];
const BUDGET_TAG = 'skillopt_hook_budget_exhausted';

let engine: PGLiteEngine;
let dir: string;
let skillsDir: string;
let optimizerPrompts: string[];
let targetTasks: string[];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-wave-'));
  skillsDir = dir;
  fs.mkdirSync(path.join(skillsDir, SKILL), { recursive: true });
  fs.writeFileSync(skillFile(), BASE);
  optimizerPrompts = [];
  targetTasks = [];
});
afterEach(() => {
  __setChatTransportForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const skillFile = () => path.join(skillsDir, SKILL, 'SKILL.md');
const add = (section: string): EditOp => ({ op: 'add', anchor: '## People', content: `## ${section}\nok.`, reason: 'r' });

function task(id: string, text: string, checks: Array<{ op: string; arg: string }>): BenchmarkTask {
  return { task_id: id, task: text, judge: { kind: 'rule', checks } } as BenchmarkTask;
}
/** Sorted ids a-/b-/c- land in train/sel/test under --split 1:1:1. */
function writeBench(checks: (id: string) => Array<{ op: string; arg: string }>, n = 5): string {
  const rows: BenchmarkTask[] = [];
  for (const [prefix, label] of [['a', 'TRAIN'], ['b', 'SEL'], ['c', 'TEST']] as const) {
    for (let i = 1; i <= n; i++) rows.push(task(`${prefix}-${i}`, `${label} task ${i}`, checks(`${prefix}-${i}`)));
  }
  const p = path.join(skillsDir, SKILL, 'skillopt-benchmark.jsonl');
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
function reply(text: string, model: string): ChatResult {
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model, providerId: 'anthropic',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 } };
}
/** Target emits the sections its skill has; each optimizer call takes the next queued reply. */
function installStub(optimizer: Array<EditOp[] | string>): void {
  let n = 0;
  __setChatTransportForTests(async (o: ChatOpts) => {
    const sys = o.system ?? '';
    const user = typeof o.messages[0]?.content === 'string' ? o.messages[0].content : '';
    if (sys.startsWith("You are SkillOpt's optimizer")) {
      optimizerPrompts.push(`${sys}\n${user}`);
      const next = optimizer[n++] ?? [];
      return reply(typeof next === 'string' ? next : JSON.stringify({ edits: next }), o.model ?? OPTIMIZER);
    }
    targetTasks.push(user);
    const out = SECTIONS.filter((s) => sys.includes(`## ${s}`)).map((s) => `## ${s}\nok`).join('\n\n');
    return reply(out || 'nothing', o.model ?? TARGET);
  });
}

function opts(over: Partial<SkillOptOpts>): SkillOptOpts {
  return {
    engine, skillName: SKILL, skillsDir,
    epochs: 1, batchSize: 5, lr: 4, lrSchedule: 'constant', split: [1, 1, 1],
    optimizerModel: OPTIMIZER, targetModel: TARGET, judgeModel: TARGET,
    mode: 'patch', dryRun: false, noMutate: false, allowMutateBundled: true,
    bootstrapReviewed: false, json: true, maxCostUsd: 100, maxRuntimeMin: 2, force: true,
    ...over,
  } as SkillOptOpts;
}
const run = (o: SkillOptOpts) => withEnv({ GBRAIN_AUDIT_DIR: dir }, () => runSkillOpt(o));

describe('B1.4: criteria override', () => {
  const checks = (id: string) => [{ op: 'contains', arg: `ANSWER-${id}` }, { op: 'section_present', arg: 'Citations' }];

  test('criteriaText replaces the generated criteria verbatim', async () => {
    const benchmarkPath = writeBench(checks);
    installStub([[]]);
    await run(opts({ benchmarkPath, criteriaText: 'OPERATOR CRITERIA: cite every claim' }));
    for (const p of optimizerPrompts) {
      expect(p).toContain('OPERATOR CRITERIA: cite every claim');
      expect(p).not.toContain('task-specific');
      expect(p).not.toContain('"Citations"');
    }
  });
});

describe('B1.2 / B1.3 / B1.6: explicit tasks, rollout hook, receipt counts', () => {
  const ids = (prefix: string, n: number, label: string) =>
    Array.from({ length: n }, (_, i) => task(`${prefix}-${i + 1}`, `${label} task ${i + 1}`, [{ op: 'contains', arg: 'Citations' }]));
  const lists = () => ({ train: ids('t', 6, 'TRAIN'), sel: ids('s', 5, 'SEL') });

  function countingHook(onCall?: (req: RolloutBatchRequest, nth: number) => void) {
    const calls: RolloutBatchRequest[] = [];
    const hook = async (req: RolloutBatchRequest): Promise<ScoredRollout[][]> => {
      calls.push(req);
      onCall?.(req, calls.length);
      const score = req.skillText.includes('## Citations') ? 1 : 0;
      return req.tasks.map((t) => Array.from({ length: req.runsPerTask }, () => ({
        score,
        trajectory: {
          task_id: t.task_id, task: req.phase === 'train_forward' ? t.task : '', final_text: req.phase === 'train_forward' ? 'out' : '',
          tool_calls: [], turns: 1, stop_reason: 'end', duration_ms: 0,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
        },
      } as ScoredRollout)));
    };
    return { hook, calls };
  }

  test('every rollout goes through the hook, on the given lists, and the receipt counts them', async () => {
    const { hook, calls } = countingHook();
    installStub([[add('Citations')]]);
    const t = lists();
    const res = await run(opts({ tasks: t, rolloutHook: hook, epochs: 2, batchSize: 3 }));
    expect(res.outcome).toBe('accepted');
    expect(targetTasks).toHaveLength(0);
    const train = new Set(t.train.map((x) => x.task_id));
    const sel = new Set(t.sel.map((x) => x.task_id));
    for (const c of calls) {
      const want = c.phase === 'train_forward' ? train : sel;
      for (const x of c.tasks) expect(want.has(x.task_id)).toBe(true);
      expect(c.runsPerTask).toBe(c.phase === 'train_forward' ? 1 : 3);
    }
    expect(calls.some((c) => c.phase === 'test')).toBe(false);
    expect(res.receipt.test_score).toBeUndefined();
    const sum = (phase: string) => calls.filter((c) => c.phase === phase).reduce((n, c) => n + c.tasks.length * c.runsPerTask, 0);
    expect(res.receipt.rollouts).toEqual({ baseline_sel: sum('baseline_sel'), train_forward: sum('train_forward'), sel_gate: sum('sel_gate'), held_out: 0, test: 0 });
    expect(res.receipt.candidates_scored_on_sel).toBe(new Set(calls.filter((c) => c.phase === 'sel_gate').map((c) => c.skillSha256)).size);
    expect(res.receipt.optimizer_calls).toBe(optimizerPrompts.length);
    expect(res.receipt.cost_scope).toBe('optimizer_only');
    expect(res.receipt.optimizer_mode).toBe('reflect');
  });

  test('a hook budget refusal mid-step aborts with the previous best on disk and no new buffer rows', async () => {
    let selGates = 0;
    const { hook } = countingHook((req) => {
      if (req.phase === 'sel_gate' && ++selGates === 2) throw new Error(`${BUDGET_TAG}: shared cap reached`);
    });
    installStub([[add('Citations')], [add('Summary')]]);
    const res = await run(opts({ tasks: lists(), rolloutHook: hook, batchSize: 3 }));
    expect(res.outcome).toBe('aborted');
    expect(res.receipt.abort_reason).toBe('budget_exhausted');
    expect(res.receipt.abort_detail).toContain(BUDGET_TAG);
    const text = fs.readFileSync(skillFile(), 'utf8');
    expect(text).toContain('## Citations');
    expect(text).not.toContain('## Summary');
    expect(loadRejectedBuffer(skillsDir, SKILL)).toHaveLength(0);
  });

  test('explicit tasks and a benchmark file together are refused before any call', async () => {
    installStub([]);
    await expect(run(opts({ tasks: lists(), benchmarkPath: writeBench(() => [{ op: 'contains', arg: 'x' }]) })))
      .rejects.toMatchObject({ envelope: { code: 'explicit_tasks_conflict' } });
    expect(optimizerPrompts).toHaveLength(0);
  });
});
