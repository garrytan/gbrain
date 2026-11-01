/**
 * SkillOpt wave E1 + B1 (GBRA-274): one-shot rewrite by default, the benchmark
 * hooks gbrain-evals needs (explicit task lists, a batch rollout hook, receipt
 * counts, no gold-leaking criteria) and defects 2-4.
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
import { loadHistory } from '../../src/core/skillopt/version-store.ts';
import { loadRejectedBuffer, rejectedFilePath } from '../../src/core/skillopt/rejected-buffer.ts';
import { runSkillOptJob } from '../../src/core/skillopt/job.ts';
import { BudgetExhausted } from '../../src/core/budget/budget-tracker.ts';
import { loadCheckpoint } from '../../src/core/skillopt/checkpoint.ts';
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
let heldOutThrows: boolean;

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
  heldOutThrows = false;
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
function writeHeldOut(): string {
  const p = path.join(skillsDir, SKILL, 'held-out.jsonl');
  const rows = Array.from({ length: 5 }, (_, i) => task(`h-${i + 1}`, `HELDOUT task ${i + 1}`, [{ op: 'contains', arg: 'People' }]));
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
    if (heldOutThrows && user.startsWith('HELDOUT')) {
      throw new BudgetExhausted('skillopt:x: projected cost $2 exceeds --max-cost $1.00', { reason: 'cost', spent: 0.5, cap: 1 });
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
    mode: 'patch', optimizerMode: 'reflect', dryRun: false, noMutate: false, allowMutateBundled: true,
    bootstrapReviewed: false, json: true, maxCostUsd: 100, maxRuntimeMin: 2, force: true,
    ...over,
  } as SkillOptOpts;
}
const run = (o: SkillOptOpts) => withEnv({ GBRAIN_AUDIT_DIR: dir }, () => runSkillOpt(o));

describe('defect 4: only applied edits are filed or recorded', () => {
  test('LR budget 1, three proposals, gate rejects: one rejected-buffer row', async () => {
    const benchmarkPath = writeBench(() => [{ op: 'contains', arg: 'Citations' }]);
    installStub([[add('Bogus1'), add('Bogus2'), add('Bogus3')]]);
    const res = await run(opts({ benchmarkPath, lr: 1 }));
    expect(res.outcome).toBe('no_improvement');
    const rows = loadRejectedBuffer(skillsDir, SKILL);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.edits)).toContain('Bogus1');
  });

  test('LR budget 1, three proposals, gate accepts: history lists the applied edit only, clipped edits stay unfiled', async () => {
    const benchmarkPath = writeBench(() => [{ op: 'contains', arg: 'Citations' }]);
    installStub([[add('Citations'), add('Bogus2'), add('Bogus3')]]);
    const res = await run(opts({ benchmarkPath, lr: 1 }));
    expect(res.outcome).toBe('accepted');
    const committed = loadHistory(skillsDir, SKILL).filter((r) => r.status === 'committed');
    expect(committed).toHaveLength(1);
    expect(committed[0]!.edits).toHaveLength(1);
    expect(JSON.stringify(committed[0]!.edits)).toContain('Citations');
    expect(loadRejectedBuffer(skillsDir, SKILL)).toHaveLength(0);
  });
});

describe('defect 3 + B1.4: no gold-leaking criteria', () => {
  const checks = (id: string) => [{ op: 'contains', arg: `ANSWER-${id}` }, { op: 'section_present', arg: 'Citations' }];

  for (const optimizerMode of ['reflect', 'one-shot-rewrite'] as const) {
    test(`${optimizerMode}: a shared format rule reaches the optimizer, per-task answers never do`, async () => {
      const benchmarkPath = writeBench(checks);
      installStub([optimizerMode === 'reflect' ? [] : '# Wave\n\n## People\nList people.\n']);
      await run(opts({ benchmarkPath, optimizerMode }));
      expect(optimizerPrompts.length).toBeGreaterThan(0);
      for (const p of optimizerPrompts) {
        expect(p).toContain('"Citations"');
        expect(p).not.toContain('ANSWER-');
      }
    });
  }

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

describe('defect 2: held-out stays out of the proposer and runs once', () => {
  test('a legacy held_out_regression row on disk never reaches an optimizer prompt', async () => {
    const benchmarkPath = writeBench(() => [{ op: 'contains', arg: 'Citations' }]);
    const legacy = { key: 'deadbeef', skill_sha8: 'deadbeef', reason: 'held_out_regression', ts: new Date().toISOString(),
      edits: [{ op: 'add', anchor: '## People', content: 'LEAKED-HELDOUT-VERDICT' }] };
    fs.mkdirSync(path.dirname(rejectedFilePath(skillsDir, SKILL)), { recursive: true });
    fs.writeFileSync(rejectedFilePath(skillsDir, SKILL), JSON.stringify({ schema: 1, entries: [legacy] }));
    installStub([[]]);
    await run(opts({ benchmarkPath }));
    expect(optimizerPrompts.length).toBeGreaterThan(0);
    for (const p of optimizerPrompts) {
      expect(p).not.toContain('LEAKED-HELDOUT-VERDICT');
      expect(p).not.toContain('held_out');
    }
  });

  test('two accepted loop steps: the held-out set is scored once, on the final champion, then written once', async () => {
    const benchmarkPath = writeBench(() => [{ op: 'contains', arg: 'Citations' }, { op: 'contains', arg: 'Summary' }]);
    installStub([[add('Citations')], [add('Summary')]]);
    const res = await run(opts({ benchmarkPath, heldOutPath: writeHeldOut(), batchSize: 2 }));
    expect(res.outcome).toBe('accepted');
    expect(targetTasks.filter((t) => t.startsWith('HELDOUT')).length).toBe(5 * 3 * 2);
    expect(res.receipt.held_out).toEqual({ baseline_score: 1, candidate_score: 1, passed: true });
    expect(res.receipt.rollouts?.held_out).toBe(30);
    expect(loadHistory(skillsDir, SKILL).filter((r) => r.status === 'committed')).toHaveLength(1);
    const text = fs.readFileSync(skillFile(), 'utf8');
    expect(text).toContain('## Citations');
    expect(text).toContain('## Summary');
  });

  test('a champion the held-out check refuses is never written and never filed for the proposer', async () => {
    const benchmarkPath = writeBench(() => [{ op: 'contains', arg: 'Citations' }]);
    installStub([[{ op: 'replace', target: '## People\nList people.', replacement: '## Citations\nCite.', reason: 'r' }]]);
    const res = await run(opts({ benchmarkPath, heldOutPath: writeHeldOut() }));
    expect(res.outcome).toBe('no_improvement');
    expect(res.receipt.held_out?.passed).toBe(false);
    expect(res.mutatedSkillFile).toBe(false);
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(BASE);
    expect(loadRejectedBuffer(skillsDir, SKILL)).toHaveLength(0);
    const buf = rejectedFilePath(skillsDir, SKILL);
    if (fs.existsSync(buf)) expect(fs.readFileSync(buf, 'utf8')).not.toContain('held_out');
  });

  test('a resumed run never returns the pending champion it did not write, on abort or on held-out refusal', async () => {
    const benchmarkPath = writeBench(() => [{ op: 'contains', arg: 'Citations' }]);
    const heldOutPath = writeHeldOut();
    installStub([[{ op: 'replace', target: '## People\nList people.', replacement: '## Citations\nCite.', reason: 'r' }]]);
    heldOutThrows = true;
    const first = await run(opts({ benchmarkPath, heldOutPath }));
    expect(first.outcome).toBe('aborted');
    const runId = first.receipt.run_id;
    expect(loadCheckpoint(skillsDir, SKILL, runId)!.champion).toBeDefined();
    expect(first.finalText).toBe(BASE);

    const again = await run(opts({ benchmarkPath, heldOutPath, resumeRunId: runId }));
    expect(again.outcome).toBe('aborted');
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(BASE);
    expect(again.finalText).toBe(BASE);

    heldOutThrows = false;
    const last = await run(opts({ benchmarkPath, heldOutPath, resumeRunId: runId }));
    expect(last.receipt.held_out?.passed).toBe(false);
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(BASE);
    expect(last.finalText).toBe(BASE);
  });
});

describe('E1: one-shot rewrite is a gated step on train data', () => {
  test('the rewrite reflects on train tasks only, never selection tasks', async () => {
    const benchmarkPath = writeBench(() => [{ op: 'contains', arg: 'Citations' }]);
    installStub(['# Wave\n\n## People\nList people.\n\n## Citations\nCite.\n']);
    const res = await run(opts({ benchmarkPath, optimizerMode: 'one-shot-rewrite' }));
    expect(res.receipt.optimizer_mode).toBe('one-shot-rewrite');
    expect(optimizerPrompts).toHaveLength(1);
    expect(optimizerPrompts[0]).toContain('TRAIN task');
    expect(optimizerPrompts[0]).not.toContain('SEL task');
    expect(res.outcome).toBe('accepted');
    expect(fs.readFileSync(skillFile(), 'utf8')).toContain('## Citations');
  });

  test('a rewrite that scores below baseline on selection is not promoted', async () => {
    fs.writeFileSync(skillFile(), BASE + '\n## Citations\nCite.\n');
    const before = fs.readFileSync(skillFile(), 'utf8');
    const benchmarkPath = writeBench(() => [{ op: 'contains', arg: 'Citations' }]);
    installStub(['# Wave\n\n## People\nList people.\n']);
    const res = await run(opts({ benchmarkPath, optimizerMode: 'one-shot-rewrite' }));
    expect(res.outcome).toBe('no_improvement');
    expect(res.mutatedSkillFile).toBe(false);
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(before);
  });

  test('a queued job without optimizer_mode keeps the loop it was queued for; a new one carries its mode', async () => {
    const benchmarkPath = writeBench(() => [{ op: 'contains', arg: 'Citations' }]);
    const base = { skills_dir: skillsDir, skill_name: SKILL, benchmark_path: benchmarkPath, split: [1, 1, 1], dry_run: true, force: true,
      optimizer_model: OPTIMIZER, target_model: TARGET, judge_model: TARGET, max_cost_usd: 100 };
    const legacy = await runSkillOptJob(engine, base) as { receipt: { optimizer_mode: string } };
    expect(legacy.receipt.optimizer_mode).toBe('reflect');
    const current = await runSkillOptJob(engine, { ...base, optimizer_mode: 'one-shot-rewrite' }) as { receipt: { optimizer_mode: string } };
    expect(current.receipt.optimizer_mode).toBe('one-shot-rewrite');
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

  test('one-shot under a hook that returns score-only rows outside train_forward completes', async () => {
    const { hook, calls } = countingHook();
    installStub(['# Wave\n\n## People\nList people.\n\n## Citations\nCite.\n']);
    const res = await run(opts({ tasks: lists(), rolloutHook: hook, optimizerMode: 'one-shot-rewrite', batchSize: 3 }));
    expect(res.outcome).toBe('accepted');
    expect(calls.map((c) => c.phase)).toEqual(['baseline_sel', 'train_forward', 'sel_gate']);
    expect(calls[1]!.tasks.map((x) => x.task_id)).toEqual(['t-1', 't-2', 't-3']);
  });

  test('explicit tasks and a benchmark file together are refused before any call', async () => {
    installStub([]);
    await expect(run(opts({ tasks: lists(), benchmarkPath: writeBench(() => [{ op: 'contains', arg: 'x' }]) })))
      .rejects.toMatchObject({ envelope: { code: 'explicit_tasks_conflict' } });
    expect(optimizerPrompts).toHaveLength(0);
  });
});
