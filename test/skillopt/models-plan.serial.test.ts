/**
 * #5585 — skillopt models plan: role resolution with provenance, task judge
 * overrides (benchmark + held-out), engine-internal touchpoints (expansion,
 * chat, embedding from the search column resolver, reranker when enabled),
 * the stderr banner, strict-mode verdict/value parsing and echo sanitizing.
 *
 * Serial lane: pins provider/home env vars and gateway module state.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { withEnv } from '../helpers/with-env.ts';
import { configureGateway, reconfigureGatewayWithEngine, resetGateway } from '../../src/core/ai/gateway.ts';
import { _resetDeprecationWarningsForTest, TIER_DEFAULTS } from '../../src/core/model-config.ts';
import { KNOWN_CONFIG_KEYS } from '../../src/core/config.ts';
import {
  buildModelsPlan,
  describeStrictVerdict,
  formatModelsBanner,
  modelsStrictError,
  parseModelsStrict,
  resolveModelsStrict,
  resolveSkillOptModels,
  sanitizeEcho,
  strictVerdict,
  unknownProvenanceModels,
  type ModelsPlanEntry,
} from '../../src/core/skillopt/models-plan.ts';
import { StructuredAgentError } from '../../src/core/errors.ts';
import type { BenchmarkTask } from '../../src/core/skillopt/types.ts';

const OPUS = 'anthropic:claude-opus-4-7';
const SONNET = 'anthropic:claude-sonnet-4-6';
const HAIKU = 'anthropic:claude-haiku-4-5-20251001';

let engine: PGLiteEngine;
let tmpHome: string;
let stderr = '';
const origWrite = process.stderr.write.bind(process.stderr);

const ENV = () => ({
  GBRAIN_HOME: tmpHome, ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: undefined,
  GBRAIN_MODEL: undefined, GBRAIN_CHAT_MODEL: undefined, GBRAIN_EXPANSION_MODEL: undefined,
  GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_MODEL_DISCOVERY: 'off',
});
const inEnv = <T>(fn: () => Promise<T>, extra: Record<string, string | undefined> = {}) => withEnv({ ...ENV(), ...extra }, fn);

const rule = (id: string): BenchmarkTask => ({ task_id: id, task: 't', judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'x' }] } });
const llm = (id: string, model?: string): BenchmarkTask => ({ task_id: id, task: 't', judge: { kind: 'llm', rubric: 'r', ...(model ? { model } : {}) } });

async function explicitEverything(): Promise<void> {
  await engine.setConfig('models.tier.deep', OPUS);
  await engine.setConfig('models.tier.subagent', SONNET);
  await engine.setConfig('models.tier.reasoning', SONNET);
  await engine.setConfig('models.tier.utility', HAIKU);
  await engine.setConfig('models.chat', SONNET);
  await engine.setConfig('search.reranker.model', 'voyage:rerank-2.5');
  mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
  writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_model: 'openai:text-embedding-3-large' }));
  configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  await reconfigureGatewayWithEngine(engine);
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
  tmpHome = mkdtempSync(join(tmpdir(), 'skillopt-models-plan-'));
  resetGateway();
  _resetDeprecationWarningsForTest();
  stderr = '';
  process.stderr.write = ((c: string | Uint8Array) => { stderr += String(c); return true; }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = origWrite;
  resetGateway();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('resolveSkillOptModels', () => {
  test('flag > tier config > models.default > built-in default, each with its origin key', async () => {
    await inEnv(async () => {
      await engine.setConfig('models.tier.deep', OPUS);
      await engine.setConfig('models.default', SONNET);
      const m = await resolveSkillOptModels(engine, { judgeModel: 'opus' });
      expect(m.optimizer).toEqual({ model: OPUS, source: 'tier_config', origin: 'models.tier.deep' });
      expect(m.target).toEqual({ model: SONNET, source: 'models_default', origin: 'models.default' });
      expect(m.judge).toEqual({ model: OPUS, source: 'cli_flag', origin: '--judge-model' });
    });
    await resetPgliteState(engine);
    await inEnv(async () => {
      const m = await resolveSkillOptModels(engine);
      expect(m.optimizer).toEqual({ model: TIER_DEFAULTS.deep, source: 'tier_default', origin: 'built-in default' });
    });
  });

  test('a subagent capability substitution is reported with the configured model and reason', async () => {
    await inEnv(async () => {
      await engine.setConfig('models.tier.subagent', 'bogus-provider:some-model');
      const m = await resolveSkillOptModels(engine);
      expect(m.target).toEqual({
        model: TIER_DEFAULTS.subagent, source: 'tier_config', origin: 'models.tier.subagent',
        substituted_from: 'bogus-provider:some-model', substitution_reason: 'unknown_provider',
      });
    });
  });
});

describe('buildModelsPlan', () => {
  test('lists every touchpoint with sources; task judge overrides are listed with their task count', async () => {
    await inEnv(async () => {
      await explicitEverything();
      const models = await resolveSkillOptModels(engine);
      const plan = await buildModelsPlan(engine, models, [llm('a'), llm('b', 'openai:gpt-5.2'), llm('c', 'openai:gpt-5.2'), rule('d')]);
      expect(plan.map((e) => [e.touchpoint, e.model, e.source, e.active])).toEqual([
        ['optimizer', OPUS, 'tier_config', true],
        ['target', SONNET, 'tier_config', true],
        ['judge', SONNET, 'tier_config', true],
        ['judge', 'openai:gpt-5.2', 'benchmark', true],
        ['expansion', HAIKU, 'tier_config', true],
        ['chat', SONNET, 'config_key', true],
        ['embedding', 'openai:text-embedding-3-large', 'file_config', true],
        ['reranker', 'voyage:rerank-2.5', 'config_key', true],
      ]);
      expect(plan[3]!.origin).toBe('benchmark judge.model, 2 tasks');
      expect(strictVerdict(plan, { on: true })).toEqual({ enabled: true, ok: true, violations: [] });

      const banner = formatModelsBanner(plan, { skill: 'widget-example' });
      expect(banner).toContain('[skillopt] Models for widget-example:');
      expect(banner).toContain('[skillopt]   optimizer  anthropic:claude-opus-4-7  (models.tier.deep)\n');
      expect(banner).toContain('judge      openai:gpt-5.2  (benchmark judge.model, 2 tasks)');
      expect(banner).toContain('embedding  openai:text-embedding-3-large  (embedding_model (config.json))');
      expect(banner).not.toContain(' *');
    });
  });

  test('rule-only benchmark marks the default judge inactive; an LLM-judged held-out task reactivates it', async () => {
    await inEnv(async () => {
      const models = await resolveSkillOptModels(engine);
      const ruleOnly = await buildModelsPlan(engine, models, [rule('a'), rule('b')]);
      const judge = ruleOnly.find((e) => e.touchpoint === 'judge')!;
      expect(judge).toMatchObject({ active: false, inactive_reason: 'rule/qrels benchmark' });
      expect(formatModelsBanner(ruleOnly)).toContain('(inactive: rule/qrels benchmark)');
      expect(strictVerdict(ruleOnly, { on: true }).violations.map((v) => v.touchpoint)).not.toContain('judge');

      const withHeldOut = await buildModelsPlan(engine, models, [rule('a'), llm('h1')]);
      expect(withHeldOut.find((e) => e.touchpoint === 'judge')!.active).toBe(true);

      const allOverridden = await buildModelsPlan(engine, models, [llm('a', 'openai:gpt-5.2')]);
      expect(allOverridden.find((e) => e.touchpoint === 'judge' && e.source !== 'benchmark')).toMatchObject({
        active: false, inactive_reason: 'every LLM task sets judge.model',
      });

      const unknownKind = await buildModelsPlan(engine, models, [{ task_id: 'x', task: 't', judge: { kind: 'vibes' } as never }]);
      expect(unknownKind.find((e) => e.touchpoint === 'judge')!.active).toBe(true);
    });
  });

  test('fallback sources are starred with a footnote; unresolved gateway provenance is unknown', async () => {
    await inEnv(async () => {
      configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
      await engine.setConfig('models.default', SONNET);
      const plan = await buildModelsPlan(engine, await resolveSkillOptModels(engine));
      const banner = formatModelsBanner(plan);
      expect(banner).toContain('optimizer  anthropic:claude-sonnet-4-6  (models.default) *');
      expect(banner).toContain('expansion  anthropic:claude-haiku-4-5-20251001  (unrecorded: gateway not resolved against this brain) *');
      expect(banner).toContain('* not chosen by touchpoint-specific configuration');
      expect(plan.find((e) => e.touchpoint === 'expansion')!.source).toBe('unknown');
    });
  });

  test('embedding: a stale DB embedding_model row is never the source; a DB-selected column is', async () => {
    await inEnv(async () => {
      await engine.setConfig('embedding_model', 'voyage:voyage-3-large');
      const plain = await buildModelsPlan(engine, await resolveSkillOptModels(engine));
      const emb = plain.find((e) => e.touchpoint === 'embedding')!;
      expect(emb.model).not.toBe('voyage:voyage-3-large');
      expect(emb.source).toBe('fallback');

      await engine.setConfig('embedding_columns', JSON.stringify({ embedding_voyage: { provider: 'voyage:voyage-3-large', dimensions: 1024, type: 'vector' } }));
      await engine.setConfig('search_embedding_column', 'embedding_voyage');
      const col = (await buildModelsPlan(engine, await resolveSkillOptModels(engine))).find((e) => e.touchpoint === 'embedding')!;
      expect(col).toMatchObject({
        model: 'voyage:voyage-3-large', source: 'config_key',
        origin: 'search_embedding_column=embedding_voyage (embedding_columns)',
      });
      expect(strictVerdict([col], { on: true }).ok).toBe(true);
    });
    await resetPgliteState(engine);
    await inEnv(async () => {
      // An explicit override of the default column is configuration, not a fallback.
      await engine.setConfig('embedding_columns', JSON.stringify({ embedding: { provider: 'voyage:voyage-3-large', dimensions: 1024, type: 'vector' } }));
      const def = (await buildModelsPlan(engine, await resolveSkillOptModels(engine))).find((e) => e.touchpoint === 'embedding')!;
      expect(def).toMatchObject({ model: 'voyage:voyage-3-large', source: 'config_key', origin: 'embedding_columns.embedding' });
      expect(strictVerdict([def], { on: true }).ok).toBe(true);
    });
    await resetPgliteState(engine);
    await inEnv(async () => {
      const envEmb = (await buildModelsPlan(engine, await resolveSkillOptModels(engine))).find((e) => e.touchpoint === 'embedding')!;
      expect(envEmb).toMatchObject({ model: 'openai:text-embedding-3-large', source: 'env', origin: 'GBRAIN_EMBEDDING_MODEL' });
    }, { GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large' });
  });

  test('reranker appears only when search enables it; an explicit model is named', async () => {
    await inEnv(async () => {
      await engine.setConfig('search.reranker.enabled', 'false');
      const off = await buildModelsPlan(engine, await resolveSkillOptModels(engine));
      expect(off.some((e) => e.touchpoint === 'reranker')).toBe(false);

      await engine.setConfig('search.reranker.enabled', 'true');
      const def = (await buildModelsPlan(engine, await resolveSkillOptModels(engine))).find((e) => e.touchpoint === 'reranker')!;
      expect(def.source).toBe('fallback');
      expect(def.origin).toStartWith('built-in default, search.mode ');

      await engine.setConfig('search.reranker.model', 'voyage:rerank-2.5');
      const explicit = (await buildModelsPlan(engine, await resolveSkillOptModels(engine))).find((e) => e.touchpoint === 'reranker')!;
      expect(explicit).toMatchObject({ model: 'voyage:rerank-2.5', source: 'config_key', origin: 'search.reranker.model' });
    });
  });
});

describe('banner baseline (batch / cycle)', () => {
  test('only rows that differ from the invocation banner print; identical plans print nothing', async () => {
    await inEnv(async () => {
      const models = await resolveSkillOptModels(engine);
      const base = await buildModelsPlan(engine, models);
      expect(formatModelsBanner(base, { skill: 's', baseline: base })).toBe('');
      const ruleOnly = await buildModelsPlan(engine, models, [rule('a')]);
      const diff = formatModelsBanner(ruleOnly, { skill: 's', baseline: base });
      expect(diff).toContain('[skillopt] Models for s (differs from the run banner):');
      expect(diff).toContain('(inactive: rule/qrels benchmark)');
      expect(diff).not.toContain('optimizer');
    });
  });
});

describe('strict mode', () => {
  test('violations list each touchpoint with a copy-paste fix; embedding fix points at config.json/env, never config set', async () => {
    await inEnv(async () => {
      configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
      await engine.setConfig('models.default', SONNET);
      await reconfigureGatewayWithEngine(engine);
      const plan = await buildModelsPlan(engine, await resolveSkillOptModels(engine));
      const verdict = strictVerdict(plan, { on: true });
      expect(verdict.ok).toBe(false);
      const fixes = Object.fromEntries(verdict.violations.map((v) => [v.touchpoint, v.fix]));
      expect(fixes.optimizer).toBe(`gbrain config set models.tier.deep ${SONNET}`);
      expect(fixes.target).toBe(`gbrain config set models.tier.subagent ${SONNET}`);
      expect(fixes.judge).toBe(`gbrain config set models.tier.reasoning ${SONNET}`);
      expect(fixes.expansion).toBe(`gbrain config set models.tier.utility ${SONNET}`);
      expect(fixes.chat).toBe(`gbrain config set models.chat ${SONNET}`);
      expect(fixes.embedding).toContain('~/.gbrain/config.json or export GBRAIN_EMBEDDING_MODEL=');
      expect(fixes.embedding).not.toContain('config set embedding_model');

      const err = modelsStrictError(verdict) as StructuredAgentError;
      expect(err.envelope.code).toBe('models_strict_violation');
      expect(err.envelope.message).toContain('  expansion  anthropic:claude-sonnet-4-6  (models.default)');
      expect(err.envelope.message).toContain(`    gbrain config set models.tier.utility ${SONNET}`);
    });
  });

  test('substitution and unknown provenance count as fallback; explicit sources pass', async () => {
    await inEnv(async () => {
      await engine.setConfig('models.tier.subagent', 'bogus-provider:some-model');
      const m = await resolveSkillOptModels(engine);
      const plan = await buildModelsPlan(engine, m);
      expect(strictVerdict(plan.filter((e) => e.touchpoint === 'target'), { on: true }).violations[0]!.fix)
        .toBe(`gbrain config set models.tier.subagent ${TIER_DEFAULTS.subagent}`);
      expect(formatModelsBanner(plan)).toContain('(models.tier.subagent -> substituted: unknown_provider; configured bogus-provider:some-model) *');

      const legacy = unknownProvenanceModels({ optimizerModel: OPUS, targetModel: SONNET, judgeModel: SONNET }, 'legacy job data');
      const legacyPlan: ModelsPlanEntry[] = [{ touchpoint: 'optimizer', ...legacy.optimizer, active: true }];
      expect(strictVerdict(legacyPlan, { on: true }).violations.map((v) => v.origin)).toEqual(['legacy job data']);
    });
  });

  test('value parsing: on/off spellings, unrecognized warns once, counts as on and is echoed sanitized', async () => {
    for (const v of ['true', '1', 'YES', ' on ']) expect(parseModelsStrict(v)).toEqual({ on: true });
    for (const v of ['false', '0', 'no', 'off', '', null, undefined]) expect(parseModelsStrict(v)).toEqual({ on: false });
    const odd = parseModelsStrict('maybe\n\u001b[31m');
    expect(odd).toEqual({ on: true, unrecognized: 'maybe[31m' });
    parseModelsStrict('maybe\n\u001b[31m');
    expect(stderr.match(/treating it as on/g)?.length).toBe(1);

    await engine.setConfig('skillopt.models_strict', 'sometimes');
    const strict = await resolveModelsStrict(engine);
    expect(strict).toEqual({ on: true, unrecognized: 'sometimes' });
    expect(await resolveModelsStrict(engine, true)).toEqual({ on: true });
    const text = describeStrictVerdict(strictVerdict([{ touchpoint: 'optimizer', model: OPUS, source: 'tier_default', origin: 'built-in default', active: true }], strict));
    expect(text).toContain("(skillopt.models_strict='sometimes' treated as on)");
  });

  test('an unreadable strict setting fails closed (on), never silently off', async () => {
    const throwing = { getConfig: async (): Promise<string | null> => { throw new Error('db down'); } };
    expect(await resolveModelsStrict(throwing as never)).toEqual({ on: true });
    expect(stderr).toContain('could not read skillopt.models_strict; treating strict mode as on');
  });

  test('skillopt.models_strict is a registered config key', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('skillopt.models_strict');
  });
});

describe('sanitizeEcho', () => {
  test('strips control characters and newlines, caps at 200 chars', () => {
    expect(sanitizeEcho('a\nb\r\tc\u0000\u007f\u009bd')).toBe('abcd');
    expect(sanitizeEcho('x'.repeat(500))).toHaveLength(200);
  });
});
