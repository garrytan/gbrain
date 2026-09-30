/**
 * #5585 — models plan + strict mode + pre-spend admission through the real
 * runSkillOpt and every caller that funnels into it, with stub transports (no
 * real LLM, no network): banner/receipt/run_start `models_plan`, strict aborts
 * with zero model calls (config, substitution, legacy job, batch --all,
 * --target-models fleet, bootstrap), `--dry-run` previews, execution-time job
 * re-resolution, the impossible-reservation abort, guarded bootstrap under a
 * tiny cap, and the cycle's `skipped_budget` admission fingerprint.
 *
 * Serial lane: installs gateway module state and a repo-root mock, pins
 * provider/home env vars, walks shared disk state (audit JSONL, checkpoints).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let cycleSkillsDir = '';
mock.module('../../src/core/repo-root.ts', () => ({
  autoDetectSkillsDirReadOnly: () => ({ dir: cycleSkillsDir }),
}));

import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { withEnv } from '../helpers/with-env.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  reconfigureGatewayWithEngine,
  resetGateway,
  type ChatOpts,
  type ChatResult,
} from '../../src/core/ai/gateway.ts';
import { BudgetExhausted } from '../../src/core/budget/budget-tracker.ts';
import { StructuredAgentError } from '../../src/core/errors.ts';
import { _resetDeprecationWarningsForTest } from '../../src/core/model-config.ts';
import { runSkillOpt } from '../../src/core/skillopt/orchestrator.ts';
import { runBatchAll, runFleet } from '../../src/core/skillopt/batch.ts';
import { runGuardedBootstrap } from '../../src/core/skillopt/bootstrap-run.ts';
import { buildSkillOptJobData, runSkillOptJob } from '../../src/core/skillopt/job.ts';
import { resolveSkillOptModels, skillOptModelOpts } from '../../src/core/skillopt/models-plan.ts';
import { _resetAuditWriterForTests, currentAuditFilename } from '../../src/core/skillopt/audit.ts';
import type { SkillOptOpts } from '../../src/core/skillopt/types.ts';

const SKILL = 'strict-skill';
const OPUS = 'anthropic:claude-opus-4-7';
const OPUS5 = 'anthropic:claude-opus-5';
const SONNET = 'anthropic:claude-sonnet-4-6';
const HAIKU = 'anthropic:claude-haiku-4-5-20251001';

const SKILL_TEXT = `---
name: strict-skill
version: 0.1.0
description: Test skill for skillopt strict model provenance.
triggers:
  - "do the strict task"
brain_first: exempt
---

# Strict Skill

Answer the question.
`;
const BENCH = Array.from({ length: 50 }, (_, i) => ({
  task_id: `st-${String(i + 1).padStart(3, '0')}`,
  task: `Question ${i + 1}`,
  judge: { kind: 'llm', rubric: 'Is the answer complete?' },
}));

let engine: PGLiteEngine;
let skillsDir: string;
let tmpHome: string;
let benchmarkPath: string;
let chatCalls = 0;
const origWrite = process.stderr.write.bind(process.stderr);
let stderr = '';

const ENV = () => ({
  GBRAIN_HOME: tmpHome, GBRAIN_AUDIT_DIR: skillsDir, ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: undefined,
  GBRAIN_MODEL: undefined, GBRAIN_CHAT_MODEL: undefined, GBRAIN_EXPANSION_MODEL: undefined,
  GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_MODEL_DISCOVERY: 'off',
});
const inEnv = <T>(fn: () => Promise<T>) => withEnv(ENV(), fn);

function reply(text: string, model: string): ChatResult {
  return {
    text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 200, output_tokens: 40, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model, providerId: 'anthropic',
  };
}

function writeSkill(dir: string, name = SKILL): string {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), SKILL_TEXT);
  const bench = path.join(dir, name, 'skillopt-benchmark.jsonl');
  fs.writeFileSync(bench, BENCH.map((t) => JSON.stringify(t)).join('\n') + '\n');
  return bench;
}

/** Every active touchpoint chosen by touchpoint-specific configuration. */
async function explicitEverything(deep = OPUS): Promise<void> {
  await engine.setConfig('models.tier.deep', deep);
  await engine.setConfig('models.tier.subagent', HAIKU);
  await engine.setConfig('models.tier.reasoning', SONNET);
  await engine.setConfig('models.tier.utility', HAIKU);
  await engine.setConfig('models.chat', SONNET);
  await engine.setConfig('search.reranker.model', 'voyage:rerank-2.5');
  fs.mkdirSync(path.join(tmpHome, '.gbrain'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_model: 'openai:text-embedding-3-large' }));
  await reconfigureGatewayWithEngine(engine);
}

async function baseOpts(over: Partial<SkillOptOpts> = {}): Promise<SkillOptOpts> {
  return {
    engine, skillName: SKILL, skillsDir, benchmarkPath,
    epochs: 1, batchSize: 2, lr: 4, lrSchedule: 'constant', split: [4, 1, 5],
    ...skillOptModelOpts(await resolveSkillOptModels(engine)),
    mode: 'patch', dryRun: false, noMutate: false, allowMutateBundled: true, bootstrapReviewed: false,
    json: true, maxCostUsd: 100, maxRuntimeMin: 2, force: true,
    ...over,
  };
}

async function strictCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(StructuredAgentError);
    expect((err as StructuredAgentError).envelope.code).toBe('models_strict_violation');
    return (err as StructuredAgentError).envelope.message;
  }
  throw new Error('expected a models strict abort');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-strict-'));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-strict-home-'));
  benchmarkPath = writeSkill(skillsDir);
  chatCalls = 0;
  stderr = '';
  _resetAuditWriterForTests();
  _resetDeprecationWarningsForTest();
  resetGateway();
  configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  __setChatTransportForTests(async (opts: ChatOpts) => {
    chatCalls += 1;
    if (opts.purpose === 'skillopt.optimizer') return reply('{"edits": []}', opts.model!);
    if (opts.purpose === 'skillopt.judge') return reply('{"score": 0.4, "rationale": "partial"}', opts.model!);
    return reply('an answer', opts.model!);
  });
  process.stderr.write = ((c: string | Uint8Array) => { stderr += String(c); return true; }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = origWrite;
  __setChatTransportForTests(null);
  resetGateway();
  _resetAuditWriterForTests();
  fs.rmSync(skillsDir, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('runSkillOpt models plan', () => {
  test('banner before spend; models_plan on the receipt and the run_start audit row; strict verdict ok when all explicit', async () => {
    await inEnv(async () => {
      await explicitEverything();
      const res = await runSkillOpt(await baseOpts());
      expect(chatCalls).toBeGreaterThan(0);
      const plan = res.receipt.models_plan!;
      expect(plan.map((e) => e.touchpoint)).toEqual(['optimizer', 'target', 'judge', 'expansion', 'chat', 'embedding', 'reranker']);
      expect(res.receipt.models_strict).toEqual({ enabled: false, ok: true, violations: [] });
      expect(stderr).toContain('[skillopt] Models for strict-skill:');
      const runStart = fs.readFileSync(path.join(skillsDir, currentAuditFilename()), 'utf8').trim().split('\n')
        .map((l) => JSON.parse(l)).find((e) => e.kind === 'run_start' && e.run_id === res.receipt.run_id);
      expect(runStart.models_plan).toEqual(plan);
    });
  }, 60_000);

  test('strict (config) with fallback sources aborts before any model call, listing each touchpoint with its fix', async () => {
    await inEnv(async () => {
      await engine.setConfig('models.default', SONNET);
      await engine.setConfig('skillopt.models_strict', 'true');
      await reconfigureGatewayWithEngine(engine);
      const msg = await strictCode(runSkillOpt(await baseOpts()));
      expect(chatCalls).toBe(0);
      expect(msg).toContain(`gbrain config set models.tier.deep ${SONNET}`);
      expect(msg).toContain(`gbrain config set models.tier.utility ${SONNET}`);
      expect(fs.existsSync(path.join(skillsDir, currentAuditFilename()))).toBe(false);
    });
  });

  test('--models-strict with a substituted subagent model aborts with zero model calls', async () => {
    await inEnv(async () => {
      await explicitEverything();
      await engine.setConfig('models.tier.subagent', 'bogus-provider:some-model');
      const msg = await strictCode(runSkillOpt(await baseOpts({ modelsStrict: true })));
      expect(chatCalls).toBe(0);
      expect(msg).toContain('target');
      expect(msg).toContain('substituted');
    });
  });

  test('--dry-run: zero model calls; plan + strict verdict on the receipt; strict violations reported, not thrown', async () => {
    await inEnv(async () => {
      await engine.setConfig('models.default', SONNET);
      const off = await runSkillOpt(await baseOpts({ dryRun: true }));
      expect(chatCalls).toBe(0);
      expect(off.receipt.models_plan!.length).toBeGreaterThan(0);
      expect(off.receipt.models_strict).toMatchObject({ enabled: false, ok: false });

      const on = await runSkillOpt(await baseOpts({ dryRun: true, modelsStrict: true }));
      expect(chatCalls).toBe(0);
      expect(on.receipt.models_strict).toMatchObject({ enabled: true, ok: false });
    });
  });

  test('an impossible single-call reservation aborts before any model call, naming the role and control', async () => {
    await inEnv(async () => {
      await explicitEverything(OPUS5);
      let caught: unknown;
      try { await runSkillOpt(await baseOpts({ maxCostUsd: 0.5 })); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(StructuredAgentError);
      const env = (caught as StructuredAgentError).envelope;
      expect(env.code).toBe('cost_cap_exceeded');
      expect(env.message).toStartWith('reservation_exceeds_cap: a single optimizer call reserves $0.80');
      expect(env.message).toContain('skillopt.reflect_max_tokens');
      expect(chatCalls).toBe(0);
    });
  });
});

describe('background job', () => {
  test('re-resolves models at execution time (config changed after enqueue)', async () => {
    await inEnv(async () => {
      await engine.setConfig('models.tier.deep', OPUS);
      const models = await resolveSkillOptModels(engine);
      const data = buildSkillOptJobData({
        skillsDir, skillName: SKILL, benchmarkPath, epochs: 1, batchSize: 2, lr: 4, lrSchedule: 'constant', split: [4, 1, 5],
        mode: 'patch', dryRun: true, noMutate: false, allowMutateBundled: true, bootstrapReviewed: false,
        maxCostUsd: 100, maxRuntimeMin: 2, force: true, models, modelFlags: {}, modelsStrict: false,
      });
      expect(data.model_sources).toEqual({ optimizer: 'tier_config', target: 'tier_default', judge: 'tier_default' });
      await engine.setConfig('models.tier.deep', HAIKU);
      const out = await runSkillOptJob(engine, data) as { receipt: { optimizer_model: string; models_plan: Array<{ touchpoint: string; source: string }> } };
      expect(out.receipt.optimizer_model).toBe(HAIKU);
      expect(out.receipt.models_plan.find((e) => e.touchpoint === 'optimizer')!.source).toBe('tier_config');
      expect(chatCalls).toBe(0);
    });
  });

  test('legacy job data (no model_flags) reports unknown provenance and aborts under strict', async () => {
    await inEnv(async () => {
      await explicitEverything();
      await engine.setConfig('skillopt.models_strict', 'on');
      const msg = await strictCode(runSkillOptJob(engine, {
        skills_dir: skillsDir, skill_name: SKILL, benchmark_path: benchmarkPath,
        optimizer_model: OPUS, target_model: HAIKU, judge_model: SONNET, force: true, allow_mutate_bundled: true,
      }));
      expect(msg).toContain('(legacy job data)');
      expect(chatCalls).toBe(0);
    });
  });
});

describe('strict propagation through batch and fleet', () => {
  test('--all: every skill aborts pre-spend under --models-strict', async () => {
    await inEnv(async () => {
      writeSkill(skillsDir, 'second-skill');
      const models = await resolveSkillOptModels(engine);
      const out = await runBatchAll({
        engine, skillsDir, perSkillMaxCostUsd: 100, brainWideMaxCostUsd: 100,
        ...skillOptModelOpts(models), modelsStrict: true,
        epochs: 1, batchSize: 2, lr: 4, lrSchedule: 'constant', split: [4, 1, 5],
        dryRun: false, noMutate: true, allowMutateBundled: true, force: true,
      });
      expect(out.per_skill.map((s) => s.outcome)).toEqual(['errored', 'errored']);
      expect(out.per_skill.every((s) => s.reason?.includes('models strict check'))).toBe(true);
      expect(chatCalls).toBe(0);
    });
  });

  test('--target-models fleet: every target run aborts pre-spend under --models-strict', async () => {
    await inEnv(async () => {
      const models = await resolveSkillOptModels(engine);
      const out = await runFleet({
        engine, skillName: SKILL, skillsDir, benchmarkPath, targetModels: [HAIKU, SONNET],
        optimizerModel: models.optimizer.model, judgeModel: models.judge.model,
        models: { optimizer: models.optimizer, judge: models.judge }, modelsStrict: true,
        epochs: 1, batchSize: 2, lr: 4, lrSchedule: 'constant', split: [4, 1, 5],
        dryRun: false, noMutate: true, allowMutateBundled: true, bootstrapReviewed: false,
        maxCostUsd: 100, maxRuntimeMin: 2, force: true,
      });
      expect(out.per_model.map((p) => p.outcome)).toEqual(['errored', 'errored']);
      expect(chatCalls).toBe(0);
    });
  });
});

describe('guarded bootstrap', () => {
  const bootstrap = async (over: Partial<Parameters<typeof runGuardedBootstrap>[0]> = {}) => {
    const models = await resolveSkillOptModels(engine);
    return runGuardedBootstrap({
      engine, mode: 'skill', skillsDir, skillName: 'fresh-skill', optimizer: models.optimizer,
      dryRun: false, maxCostUsd: 5, ...over,
    });
  };

  beforeEach(() => {
    fs.mkdirSync(path.join(skillsDir, 'fresh-skill'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'fresh-skill', 'SKILL.md'), SKILL_TEXT);
  });

  test('a tiny --max-cost-usd aborts before the call is made; nothing is written', async () => {
    await inEnv(async () => {
      await engine.setConfig('models.tier.deep', HAIKU);
      await expect(bootstrap({ maxCostUsd: 0.001 })).rejects.toBeInstanceOf(BudgetExhausted);
      expect(chatCalls).toBe(0);
      expect(fs.existsSync(path.join(skillsDir, 'fresh-skill', 'skillopt-benchmark.jsonl'))).toBe(false);
      expect(stderr).toContain('[skillopt] Models for fresh-skill:');
    });
  });

  test('--dry-run previews the optimizer row with no call; strict aborts on a fallback optimizer', async () => {
    await inEnv(async () => {
      const preview = await bootstrap({ dryRun: true, modelsStrict: true });
      expect(preview.dry_run).toBe(true);
      expect(preview.strict).toMatchObject({ enabled: true, ok: false });
      expect(preview.models_plan.map((e) => e.touchpoint)).toEqual(['optimizer']);
      expect(chatCalls).toBe(0);
      const msg = await strictCode(bootstrap({ modelsStrict: true }));
      expect(msg).toContain('gbrain config set models.tier.deep');
      expect(chatCalls).toBe(0);
    });
  });
});

describe('cycle admission', () => {
  test('one call over the per-skill cap -> skipped_budget with zero calls; not retried until the fingerprint changes', async () => {
    await inEnv(async () => {
      cycleSkillsDir = skillsDir;
      const { runPhaseSkillopt } = await import('../../src/core/skillopt/cycle-phase.ts');
      await engine.setConfig('cycle.skillopt.enabled', 'true');
      await engine.setConfig('models.tier.deep', OPUS5);
      await engine.setConfig('cycle.skillopt.per_skill_cap_usd', '0.5');

      const first = await runPhaseSkillopt({ engine });
      const results = (first.details as { results: Array<{ skill: string; outcome: string; remediation?: Array<{ code: string }> }> }).results;
      expect(results).toEqual([expect.objectContaining({ skill: SKILL, outcome: 'skipped_budget' })]);
      expect(results[0]!.remediation!.map((r) => r.code)).toEqual(['reservation_exceeds_cap']);
      expect(chatCalls).toBe(0);
      expect(await engine.getConfig(`cycle.skillopt.last_skip.${SKILL}`)).toContain(OPUS5);
      expect(await engine.getConfig(`cycle.skillopt.last_error.${SKILL}`)).toBeNull();
      expect(await engine.getConfig(`cycle.skillopt.last_run.${SKILL}`)).toBeNull();

      const second = await runPhaseSkillopt({ engine });
      expect((second.details as { candidates?: number }).candidates).toBe(0);

      await engine.setConfig('cycle.skillopt.per_skill_cap_usd', '0.6');
      const third = await runPhaseSkillopt({ engine });
      expect((third.details as { results: Array<{ outcome: string }> }).results.map((r) => r.outcome)).toEqual(['skipped_budget']);
      expect(chatCalls).toBe(0);

      // Every priced role is in the fingerprint: a judge-tier change re-admits
      // the skill (a judge-role refusal would otherwise never be retried).
      expect((await runPhaseSkillopt({ engine }).then((r) => r.details as { candidates?: number })).candidates).toBe(0);
      await engine.setConfig('models.tier.reasoning', HAIKU);
      const judgeChanged = await runPhaseSkillopt({ engine });
      expect((judgeChanged.details as { results: Array<{ outcome: string }> }).results.map((r) => r.outcome)).toEqual(['skipped_budget']);

      // So is the skill's benchmark (per-task judge.model overrides live there).
      expect((await runPhaseSkillopt({ engine }).then((r) => r.details as { candidates?: number })).candidates).toBe(0);
      fs.appendFileSync(benchmarkPath, JSON.stringify({ ...BENCH[0], task_id: 'st-extra' }) + '\n');
      const benchChanged = await runPhaseSkillopt({ engine });
      expect((benchChanged.details as { results: Array<{ outcome: string }> }).results.map((r) => r.outcome)).toEqual(['skipped_budget']);
      expect(chatCalls).toBe(0);
    });
  });
});
