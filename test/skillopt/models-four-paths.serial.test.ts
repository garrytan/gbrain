/**
 * #5585 — four-path golden test: the CLI, the run_skillopt MCP op, the cycle
 * phase and the background job handler all resolve the optimizer / target /
 * judge roles through resolveSkillOptModels, so they hand runSkillOpt the
 * identical {model, source} plan for every config (models.default set; tiers
 * set; neither; a CLI flag, which only the CLI and its background job carry).
 * Also pins the CLI `--models-strict` flag and the `--dry-run` exit contract.
 *
 * Serial lane (isolation rule R2): runSkillOpt and repo-root are mocked with
 * mock.module; every path is loaded after the mocks so its bindings resolve to
 * them. The runSkillOpt stub is mandatory — no path may launch a real run.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-four-paths-'));
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-four-paths-home-'));
const SKILL = 'golden-skill';
fs.mkdirSync(path.join(skillsDir, SKILL), { recursive: true });
fs.writeFileSync(path.join(skillsDir, SKILL, 'skillopt-benchmark.jsonl'), '{}\n');

let captured: Array<Record<string, unknown>> = [];
mock.module('../../src/core/skillopt/orchestrator.ts', () => ({
  runSkillOpt: async (opts: Record<string, unknown>) => {
    captured.push(opts);
    const strictOn = opts.modelsStrict === true;
    return {
      outcome: 'no_improvement',
      receipt: {
        run_id: 'r', skill: SKILL, final_cost_usd: 0, best_sel_score: 0,
        models_plan: [{ touchpoint: 'optimizer', model: 'm', source: 'models_default', origin: 'models.default', active: true }],
        models_strict: { enabled: strictOn, ok: false, violations: [{ touchpoint: 'optimizer', model: 'm', source: 'models_default', origin: 'models.default', fix: 'gbrain config set models.tier.deep m' }] },
      },
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
import { _resetDeprecationWarningsForTest } from '../../src/core/model-config.ts';
import { runSkillOptCommand, parseFlags } from '../../src/commands/skillopt.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { runPhaseSkillopt } from '../../src/core/skillopt/cycle-phase.ts';
import { buildSkillOptJobData, runSkillOptJob } from '../../src/core/skillopt/job.ts';
import { resolveSkillOptModels, type SkillOptModelFlags, type SkillOptModels } from '../../src/core/skillopt/models-plan.ts';

const OPUS = 'anthropic:claude-opus-4-7';
const SONNET = 'anthropic:claude-sonnet-4-6';
const HAIKU = 'anthropic:claude-haiku-4-5-20251001';

let engine: PGLiteEngine;
const origWrite = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
const origExit = process.exit;
let stdout = '';
let exitCodes: number[] = [];

const ENV = {
  GBRAIN_HOME: tmpHome, ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: undefined,
  GBRAIN_MODEL: undefined, GBRAIN_MODEL_DISCOVERY: 'off',
};

class ExitSignal extends Error {}

type RolePlan = Record<'optimizer' | 'target' | 'judge', { model: string; source: string }>;
const roles = (opts: Record<string, unknown>): RolePlan => {
  const m = opts.models as SkillOptModels;
  const pick = (r: keyof SkillOptModels) => ({ model: m[r].model, source: m[r].source });
  return { optimizer: pick('optimizer'), target: pick('target'), judge: pick('judge') };
};

async function viaCli(args: string[] = []): Promise<Record<string, unknown>> {
  captured = [];
  try {
    await runSkillOptCommand(engine, [SKILL, '--skills-dir', skillsDir, '--json', ...args]);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
  return captured[0]!;
}

async function viaMcp(): Promise<Record<string, unknown>> {
  captured = [];
  const op = operations.find((o) => o.name === 'run_skillopt')!;
  await op.handler({ engine, config: {}, logger: console, dryRun: false, remote: false } as unknown as OperationContext, { skill_name: SKILL });
  return captured[0]!;
}

async function viaCycle(): Promise<Record<string, unknown>> {
  captured = [];
  await resetCycleState();
  await runPhaseSkillopt({ engine, once: true });
  return captured[0]!;
}

async function viaJob(flags: SkillOptModelFlags = {}): Promise<Record<string, unknown>> {
  captured = [];
  const data = buildSkillOptJobData({
    skillsDir, skillName: SKILL, benchmarkPath: path.join(skillsDir, SKILL, 'skillopt-benchmark.jsonl'),
    epochs: 1, batchSize: 2, lr: 4, lrSchedule: 'constant', split: [4, 1, 5], mode: 'patch', dryRun: false,
    noMutate: false, allowMutateBundled: false, bootstrapReviewed: false, maxCostUsd: 5, maxRuntimeMin: 30, force: false,
    models: await resolveSkillOptModels(engine, flags), modelFlags: flags, modelsStrict: false,
  });
  await runSkillOptJob(engine, JSON.parse(JSON.stringify(data)));
  return captured[0]!;
}

async function resetCycleState(): Promise<void> {
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'cycle.skillopt.%'`);
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
  _resetDeprecationWarningsForTest();
  stdout = '';
  exitCodes = [];
  process.stdout.write = ((c: string | Uint8Array) => { stdout += String(c); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.exit = ((code?: number) => { exitCodes.push(code ?? 0); throw new ExitSignal(); }) as typeof process.exit;
});

afterEach(() => {
  process.stdout.write = origWrite.out;
  process.stderr.write = origWrite.err;
  process.exit = origExit;
});

const MATRIX: Array<[string, Record<string, string>]> = [
  ['models.default set', { 'models.default': SONNET }],
  ['tiers set', { 'models.tier.deep': OPUS, 'models.tier.subagent': HAIKU, 'models.tier.reasoning': SONNET }],
  ['neither', {}],
];

describe('four-path golden role plans', () => {
  for (const [label, config] of MATRIX) {
    test(`${label}: CLI, MCP op, cycle phase and jobs handler hand runSkillOpt the same {model, source} plan`, async () => {
      await withEnv(ENV, async () => {
        for (const [k, v] of Object.entries(config)) await engine.setConfig(k, v);
        const cli = roles(await viaCli());
        expect(roles(await viaMcp())).toEqual(cli);
        expect(roles(await viaCycle())).toEqual(cli);
        expect(roles(await viaJob())).toEqual(cli);
        if (label === 'tiers set') expect(cli.optimizer).toEqual({ model: OPUS, source: 'tier_config' });
        if (label === 'models.default set') expect(cli.target).toEqual({ model: SONNET, source: 'models_default' });
        if (label === 'neither') expect(cli.judge.source).toBe('tier_default');
      });
    });
  }

  test('flag set: the CLI and its background job resolve the flag identically (source cli_flag)', async () => {
    await withEnv(ENV, async () => {
      await engine.setConfig('models.default', SONNET);
      const cli = roles(await viaCli(['--optimizer-model', 'opus']));
      expect(cli.optimizer).toEqual({ model: OPUS, source: 'cli_flag' });
      expect(roles(await viaJob({ optimizerModel: 'opus' }))).toEqual(cli);
    });
  });
});

describe('CLI strict + dry-run contract', () => {
  test('--models-strict parses and reaches runSkillOpt', async () => {
    expect(parseFlags([SKILL, '--models-strict']).modelsStrict).toBe(true);
    expect(parseFlags([SKILL]).modelsStrict).toBe(false);
    await withEnv(ENV, async () => {
      expect((await viaCli(['--models-strict'])).modelsStrict).toBe(true);
    });
  });

  test('--dry-run exits 0 when strict is off (verdict still reported) and 1 on a strict failure; --json carries the plan + verdict', async () => {
    await withEnv(ENV, async () => {
      await viaCli(['--dry-run']);
      expect(exitCodes[0]).toBe(0);
      const off = JSON.parse(stdout.trim());
      expect(off).toMatchObject({ dry_run: true, strict: { enabled: false, ok: false } });
      expect(off.models_plan).toHaveLength(1);

      stdout = '';
      exitCodes = [];
      await viaCli(['--dry-run', '--models-strict']);
      expect(exitCodes[0]).toBe(1);
      expect(JSON.parse(stdout.trim()).strict).toMatchObject({ enabled: true, ok: false });
    });
  });
});

describe('#5563 the cap source reaches runSkillOpt on every path', () => {
  test('no cap flag is a default cap (unpriced models warn and run); a cap flag is a user cap', async () => {
    await withEnv(ENV, async () => {
      const none = await viaCli();
      expect(none.maxCostUsd).toBe(5);
      expect(none.maxCostSource).toBe('default');
      const set = await viaCli(['--max-usd', '2']);
      expect(set.maxCostUsd).toBe(2);
      expect(set.maxCostSource).toBe('user');
      const off = await viaCli(['--max-usd', 'off']);
      expect(off.maxCostUsd).toBe(0);
      expect((await viaMcp()).maxCostSource).toBe('default');
    });
  });

  test('the background job carries the source; legacy job data without it stays a user cap', async () => {
    await withEnv(ENV, async () => {
      expect((await viaJob()).maxCostSource).toBe('user');
      captured = [];
      const data = buildSkillOptJobData({
        skillsDir, skillName: SKILL, benchmarkPath: path.join(skillsDir, SKILL, 'skillopt-benchmark.jsonl'),
        epochs: 1, batchSize: 2, lr: 4, lrSchedule: 'constant', split: [4, 1, 5], mode: 'patch', dryRun: false,
        noMutate: false, allowMutateBundled: false, bootstrapReviewed: false, maxCostUsd: 5, maxCostSource: 'default', maxRuntimeMin: 30, force: false,
        models: await resolveSkillOptModels(engine, {}), modelFlags: {}, modelsStrict: false,
      });
      expect(data.max_cost_source).toBe('default');
      await runSkillOptJob(engine, JSON.parse(JSON.stringify(data)));
      expect(captured[0]!.maxCostSource).toBe('default');
    });
  });
});
