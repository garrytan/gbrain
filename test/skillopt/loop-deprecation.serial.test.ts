/**
 * GST-1251: SkillOpt's iterative loop is deprecated (removal on or after 2026-12-03). Each entry point that runs the
 * loop emits the `skillopt_loop_deprecated` coaching notice exactly once per use, and an entry point that runs the
 * default one-shot rewrite emits none: the CLI (`--loop`, and a `--resume` of a checkpoint the loop wrote), the
 * run_skillopt op (`optimizer_mode: "reflect"`, rendered by MCP dispatch and the CLI op channel), and the background
 * job handler (a reflect job, and a job queued before one-shot became the default, which carries no mode). The cycle
 * phase only runs the one-shot rewrite. The run itself is unchanged: the loop still reaches runSkillOpt as 'reflect'.
 *
 * Serial lane (isolation rule R2): runSkillOpt and repo-root are mocked with mock.module and every path is loaded
 * after the mocks, so no path launches a real run.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-loop-deprecation-'));
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-loop-deprecation-home-'));
const SKILL = 'loop-skill';
fs.mkdirSync(path.join(skillsDir, SKILL), { recursive: true });
fs.writeFileSync(path.join(skillsDir, SKILL, 'skillopt-benchmark.jsonl'), '{}\n');

let captured: Array<Record<string, unknown>> = [];
mock.module('../../src/core/skillopt/orchestrator.ts', () => ({
  runSkillOpt: async (opts: Record<string, unknown>) => {
    captured.push(opts);
    return {
      outcome: 'no_improvement',
      receipt: { run_id: 'r', skill: SKILL, final_cost_usd: 0, best_sel_score: 0, models_plan: [], models_strict: { enabled: false, ok: true, violations: [] } },
      finalText: '',
      mutatedSkillFile: false,
    };
  },
  parseSplit: (s: string) => s.split(':').map(Number),
}));
mock.module('../../src/core/repo-root.ts', () => ({
  autoDetectSkillsDirReadOnly: () => ({ dir: skillsDir }),
}));

import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { withEnv } from '../helpers/with-env.ts';
import { runSkillOptCommand } from '../../src/commands/skillopt.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { runPhaseSkillopt } from '../../src/core/skillopt/cycle-phase.ts';
import { buildSkillOptJobData, runSkillOptJob } from '../../src/core/skillopt/job.ts';
import { resolveSkillOptModels } from '../../src/core/skillopt/models-plan.ts';
import { checkpointPath } from '../../src/core/skillopt/checkpoint.ts';
import { NOTICE_CODES } from '../../src/core/error-registry.ts';
import type { Notice } from '../../src/core/agent-output.ts';
import { SKILLOPT_LOOP_DEPRECATED, SKILLOPT_LOOP_REMOVAL_DATE } from '../../src/core/skillopt/loop-deprecation.ts';

const NOTICE_LINE = /\[gbrain notice skillopt_loop_deprecated\]/g;
const ENV = { GBRAIN_HOME: tmpHome, ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: undefined, GBRAIN_MODEL: undefined, GBRAIN_MODEL_DISCOVERY: 'off' };

let engine: PGLiteEngine;
const origWrite = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
const origExit = process.exit;
let stderr = '';
class ExitSignal extends Error {}

async function viaCli(args: string[]): Promise<void> {
  try {
    await runSkillOptCommand(engine, [SKILL, '--skills-dir', skillsDir, '--json', ...args]);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}

async function viaOp(params: Record<string, unknown>): Promise<Notice[]> {
  const notices: Notice[] = [];
  const op = operations.find((o) => o.name === 'run_skillopt')!;
  await op.handler({ engine, config: {}, logger: console, dryRun: false, remote: false, emitNotice: (n: Notice) => { notices.push(n); } } as unknown as OperationContext,
    { skill_name: SKILL, ...params });
  return notices;
}

async function viaJob(optimizerMode: 'reflect' | 'one-shot-rewrite' | null): Promise<void> {
  const data = buildSkillOptJobData({
    skillsDir, skillName: SKILL, benchmarkPath: path.join(skillsDir, SKILL, 'skillopt-benchmark.jsonl'),
    epochs: 1, batchSize: 2, lr: 4, lrSchedule: 'constant', split: [4, 1, 5], mode: 'patch', optimizerMode: optimizerMode ?? 'reflect', dryRun: false,
    noMutate: false, allowMutateBundled: false, bootstrapReviewed: false, maxCostUsd: 5, maxRuntimeMin: 30, force: false,
    models: await resolveSkillOptModels(engine, {}), modelFlags: {}, modelsStrict: false,
  }) as Record<string, unknown>;
  if (optimizerMode === null) delete data.optimizer_mode;
  await runSkillOptJob(engine, JSON.parse(JSON.stringify(data)));
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  fs.rmSync(skillsDir, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  captured = [];
  stderr = '';
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { stderr += String(c); return true; }) as typeof process.stderr.write;
  process.exit = (() => { throw new ExitSignal(); }) as typeof process.exit;
});

afterEach(() => {
  process.stdout.write = origWrite.out;
  process.stderr.write = origWrite.err;
  process.exit = origExit;
});

test('the notice is a registered coaching code that names the removal date and the replacement', () => {
  expect(NOTICE_CODES.skillopt_loop_deprecated).toMatchObject({ kind: 'coaching' });
  expect(SKILLOPT_LOOP_REMOVAL_DATE).toBe('2026-12-03');
  expect(SKILLOPT_LOOP_DEPRECATED).toContain('on or after 2026-12-03');
  expect(SKILLOPT_LOOP_DEPRECATED).toContain('Nothing replaces it');
  expect(SKILLOPT_LOOP_DEPRECATED).toContain('edit the skill directly');
});

describe('CLI', () => {
  test('--loop prints the notice once and still runs the loop', async () => {
    await withEnv(ENV, () => viaCli(['--loop']));
    expect(stderr.match(NOTICE_LINE)).toHaveLength(1);
    expect(stderr).toContain(SKILLOPT_LOOP_DEPRECATED);
    expect(captured.map((c) => c.optimizerMode)).toEqual(['reflect']);
  });

  test('--resume of a checkpoint the loop wrote prints the notice once', async () => {
    const file = checkpointPath(skillsDir, SKILL, 'run-loop');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: 1, run_id: 'run-loop', run_spec: { optimizer_mode: 'reflect' } }));
    try {
      await withEnv(ENV, () => viaCli(['--resume', 'run-loop']));
    } finally {
      fs.rmSync(file, { force: true });
    }
    expect(stderr.match(NOTICE_LINE)).toHaveLength(1);
    expect(captured.map((c) => c.optimizerMode)).toEqual(['reflect']);
  });

  test('the default one-shot rewrite prints no notice', async () => {
    await withEnv(ENV, () => viaCli([]));
    expect(stderr).not.toContain('skillopt_loop_deprecated');
    expect(captured.map((c) => c.optimizerMode)).toEqual(['one-shot-rewrite']);
  });
});

describe('run_skillopt op (MCP and the CLI op channel)', () => {
  test('optimizer_mode "reflect" emits the notice once and still runs the loop', async () => {
    const notices = await withEnv(ENV, () => viaOp({ optimizer_mode: 'reflect' }));
    expect(notices.filter((n) => n.code === 'skillopt_loop_deprecated')).toEqual([{ code: 'skillopt_loop_deprecated', kind: 'coaching', why: SKILLOPT_LOOP_DEPRECATED }]);
    expect(captured.map((c) => c.optimizerMode)).toEqual(['reflect']);
  });

  test('the default mode emits no notice', async () => {
    const notices = await withEnv(ENV, () => viaOp({}));
    expect(notices.filter((n) => n.code === 'skillopt_loop_deprecated')).toEqual([]);
    expect(captured.map((c) => c.optimizerMode)).toEqual(['one-shot-rewrite']);
  });
});

describe('background job handler', () => {
  test('a reflect job prints the notice once', async () => {
    await withEnv(ENV, () => viaJob('reflect'));
    expect(stderr.match(NOTICE_LINE)).toHaveLength(1);
    expect(captured.map((c) => c.optimizerMode)).toEqual(['reflect']);
  });

  test('a job queued before one-shot became the default (no mode) runs the loop and prints the notice once', async () => {
    await withEnv(ENV, () => viaJob(null));
    expect(stderr.match(NOTICE_LINE)).toHaveLength(1);
    expect(captured.map((c) => c.optimizerMode)).toEqual(['reflect']);
  });

  test('a one-shot job prints no notice', async () => {
    await withEnv(ENV, () => viaJob('one-shot-rewrite'));
    expect(stderr).not.toContain('skillopt_loop_deprecated');
  });
});

test('the cycle phase runs the one-shot rewrite and prints no notice', async () => {
  await withEnv(ENV, () => runPhaseSkillopt({ engine, once: true }));
  expect(stderr).not.toContain('skillopt_loop_deprecated');
  expect(captured.length).toBeGreaterThan(0);
  expect(captured.every((c) => c.optimizerMode === 'one-shot-rewrite')).toBe(true);
});
