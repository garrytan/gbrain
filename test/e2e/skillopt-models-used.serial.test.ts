/**
 * #5585 — skillopt receipt `models_used` built from the run's BudgetTracker
 * ledger, driven through the real runSkillOpt with stub transports (no real
 * LLM, no network): per-role purposes, an engine-internal expansion call made
 * inside a rollout, the `run_end` audit copy, and resume accounting (merged
 * prior segments, legacy checkpoints -> `since_resume`).
 *
 * Serial lane: installs gateway module state (chat / generateObject test
 * transports, configureGateway) and walks shared disk state (checkpoints,
 * audit JSONL).
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { withEnv } from '../helpers/with-env.ts';
import {
  __setChatTransportForTests,
  __setGenerateObjectTransportForTests,
  configureGateway,
  expand,
  resetGateway,
  type ChatOpts,
  type ChatResult,
} from '../../src/core/ai/gateway.ts';
import { BudgetExhausted } from '../../src/core/budget/budget-tracker.ts';
import type { ModelUsageRow } from '../../src/core/budget/models-used.ts';
import { runSkillOpt } from '../../src/core/skillopt/orchestrator.ts';
import { checkpointPath, loadCheckpoint } from '../../src/core/skillopt/checkpoint.ts';
import { _resetAuditWriterForTests, currentAuditFilename } from '../../src/core/skillopt/audit.ts';
import { formatRunSummary } from '../../src/commands/skillopt.ts';
import type { SkillOptOpts } from '../../src/core/skillopt/types.ts';

const SKILL = 'ledger-skill';
const SONNET = 'anthropic:claude-sonnet-4-6';
const HAIKU = 'anthropic:claude-haiku-4-5-20251001';

const SKILL_TEXT = `---
name: ledger-skill
version: 0.1.0
description: Test skill for the skillopt models_used receipt.
triggers:
  - "do the ledger task"
brain_first: exempt
---

# Ledger Skill

Answer the question.
`;

const BENCH = Array.from({ length: 50 }, (_, i) => ({
  task_id: `led-${String(i + 1).padStart(3, '0')}`,
  task: `Question ${i + 1}`,
  judge: { kind: 'llm', rubric: 'Is the answer complete?' },
}));

let engine: PGLiteEngine;
let skillsDir: string;
let benchmarkPath: string;
let optimizerCalls = 0;

function reply(text: string, model: string): ChatResult {
  return {
    text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 200, output_tokens: 40, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model, providerId: 'anthropic',
  };
}

/** Routes on the purpose each skillopt role stamps; the target's "search" runs a real expand(). */
function installTransport(onOptimizer: (n: number) => void = () => {}): void {
  __setChatTransportForTests(async (opts: ChatOpts) => {
    if (opts.purpose === 'skillopt.optimizer') {
      optimizerCalls += 1;
      onOptimizer(optimizerCalls);
      return reply('{"edits": []}', opts.model!);
    }
    if (opts.purpose === 'skillopt.judge') return reply('{"score": 0.4, "rationale": "partial"}', opts.model!);
    await expand('what does the ledger say');
    return reply('an answer', opts.model!);
  });
}

async function run(over: Partial<SkillOptOpts> = {}) {
  return withEnv({ GBRAIN_AUDIT_DIR: skillsDir }, () => runSkillOpt({
    engine,
    skillName: SKILL,
    skillsDir,
    benchmarkPath,
    epochs: 1,
    batchSize: 2,
    lr: 4,
    lrSchedule: 'constant',
    split: [4, 1, 5],
    optimizerModel: SONNET,
    targetModel: HAIKU,
    judgeModel: SONNET,
    mode: 'patch',
    dryRun: false,
    noMutate: false,
    allowMutateBundled: true,
    bootstrapReviewed: false,
    json: true,
    maxCostUsd: 100,
    maxRuntimeMin: 2,
    force: true,
    ...over,
  }));
}

const pricedSum = (rows: ModelUsageRow[]) => rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
const byRole = (rows: ModelUsageRow[]) => rows.map(r => [r.touchpoint, r.purpose, r.model]);
const callsOf = (rows: ModelUsageRow[], touchpoint: string, purpose: string | null) =>
  rows.find(r => r.touchpoint === touchpoint && r.purpose === purpose)?.calls ?? 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

let realWrite: typeof process.stderr.write;

beforeEach(async () => {
  await resetPgliteState(engine);
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-models-used-'));
  benchmarkPath = path.join(skillsDir, SKILL, 'skillopt-benchmark.jsonl');
  fs.mkdirSync(path.join(skillsDir, SKILL), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, SKILL, 'SKILL.md'), SKILL_TEXT);
  fs.writeFileSync(benchmarkPath, BENCH.map(t => JSON.stringify(t)).join('\n') + '\n');
  optimizerCalls = 0;
  _resetAuditWriterForTests();
  configureGateway({ expansion_model: HAIKU, env: { ANTHROPIC_API_KEY: 'sk-test-fake' } });
  __setGenerateObjectTransportForTests(async () => ({
    object: { queries: ['ledger rewrite'] },
    usage: { inputTokens: 30, outputTokens: 10 },
  }) as never);
  realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = realWrite;
  __setChatTransportForTests(null);
  __setGenerateObjectTransportForTests(null);
  resetGateway();
  _resetAuditWriterForTests();
  fs.rmSync(skillsDir, { recursive: true, force: true });
});

describe('receipt models_used', () => {
  test('one row per role (optimizer + judge on the same model stay apart) plus the engine-internal expansion', async () => {
    installTransport();
    const res = await run();
    const rows = res.receipt.models_used!;

    expect(byRole(rows)).toEqual([
      ['chat', 'skillopt.judge', SONNET],
      ['chat', 'skillopt.optimizer', SONNET],
      ['chat', 'skillopt.target', HAIKU],
      ['expansion', null, HAIKU],
    ]);
    expect(callsOf(rows, 'chat', 'skillopt.optimizer')).toBe(optimizerCalls);
    expect(callsOf(rows, 'expansion', null)).toBe(callsOf(rows, 'chat', 'skillopt.target'));
    expect(rows.every(r => r.cost_usd !== null && r.failed_calls === 0 && r.cost_basis === 'measured')).toBe(true);
    expect(res.receipt.models_used_scope).toBe('full_run');
    expect(res.receipt.prior_segments_cost_usd).toBe(0);
    expect(pricedSum(rows)).toBeCloseTo(res.receipt.final_cost_usd!, 10);

    const runEnd = fs.readFileSync(path.join(skillsDir, currentAuditFilename()), 'utf8').trim().split('\n')
      .map(l => JSON.parse(l)).find(e => e.kind === 'run_end' && e.run_id === res.receipt.run_id);
    expect(runEnd.models_used).toEqual(rows);
    expect(runEnd.models_used_scope).toBe('full_run');

    const summary = formatRunSummary(res.outcome, res.receipt, skillsDir);
    expect(summary).toContain('[skillopt] Models called (full run;');
    expect(summary).toMatch(/\[skillopt\] {3}expansion\s+engine\s+anthropic:claude-haiku-4-5-20251001/);
  });
});

describe('resume accounting', () => {
  async function abortAtThirdOptimizerCall() {
    installTransport((n) => {
      if (n === 3) throw new BudgetExhausted('skillopt:x: projected cost $2 exceeds --max-cost $1.00', { reason: 'cost', spent: 0.5, cap: 1 });
    });
    const first = await run();
    expect(first.outcome).toBe('aborted');
    return first;
  }

  test('checkpoint banks ledger rows on the handled abort; the resumed receipt merges every segment', async () => {
    const first = await abortAtThirdOptimizerCall();
    const runId = first.receipt.run_id;
    const cp = loadCheckpoint(skillsDir, SKILL, runId)!;
    expect(cp.models_used_scope).toBe('full_run');
    expect(cp.models_used).toEqual(first.receipt.models_used!);
    expect(cp.cumulative_cost_usd).toBeCloseTo(first.receipt.final_cost_usd!, 10);
    const firstOptimizerCalls = callsOf(cp.models_used!, 'chat', 'skillopt.optimizer');
    expect(firstOptimizerCalls).toBe(3);

    optimizerCalls = 0;
    installTransport();
    const second = await run({ resumeRunId: runId });
    const rows = second.receipt.models_used!;
    expect(second.receipt.models_used_scope).toBe('full_run');
    expect(second.receipt.prior_segments_cost_usd).toBeCloseTo(cp.cumulative_cost_usd, 10);
    expect(callsOf(rows, 'chat', 'skillopt.optimizer')).toBe(firstOptimizerCalls + optimizerCalls);
    expect(pricedSum(rows)).toBeCloseTo(second.receipt.prior_segments_cost_usd! + second.receipt.final_cost_usd!, 10);
  });

  test('legacy checkpoint without ledger rows -> models_used_scope since_resume', async () => {
    const first = await abortAtThirdOptimizerCall();
    const runId = first.receipt.run_id;
    const p = checkpointPath(skillsDir, SKILL, runId);
    const legacy = JSON.parse(fs.readFileSync(p, 'utf8'));
    delete legacy.models_used;
    delete legacy.models_used_scope;
    fs.writeFileSync(p, JSON.stringify(legacy));

    optimizerCalls = 0;
    installTransport();
    const second = await run({ resumeRunId: runId });
    expect(second.receipt.models_used_scope).toBe('since_resume');
    expect(callsOf(second.receipt.models_used!, 'chat', 'skillopt.optimizer')).toBe(optimizerCalls);
    expect(pricedSum(second.receipt.models_used!)).toBeCloseTo(second.receipt.final_cost_usd!, 10);
    expect(formatRunSummary(second.outcome, second.receipt, skillsDir)).toContain('Models called (since resume;');
  });
});
