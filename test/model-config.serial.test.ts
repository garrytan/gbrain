/**
 * v0.28: tests for the unified model resolver. Pure-function-style tests using
 * a tiny stub engine — no DB, no PGLite, no Postgres needed.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveModel,
  resolveModelDetailed,
  resolveAlias,
  DEFAULT_ALIASES,
  TIER_DEFAULTS,
  isAnthropicProvider,
  _resetDeprecationWarningsForTest,
} from '../src/core/model-config.ts';
import { resolveDreamModel } from '../src/core/cycle/model-routing.ts';
import { loadConfigFileOnly, readFileConfigValue, saveConfig } from '../src/core/config.ts';

class StubEngine {
  readonly kind = 'pglite' as const;
  private cfg = new Map<string, string>();
  set(key: string, value: string) { this.cfg.set(key, value); }
  async getConfig(key: string) { return this.cfg.get(key) ?? null; }
  async unsetConfig(key: string) { return this.cfg.delete(key) ? 1 : 0; }
  // unused stubs to satisfy the BrainEngine duck-type at the resolveModel boundary
  async setConfig() {}
}

let stub: StubEngine;
let stderrCapture: string;
const origWrite = process.stderr.write.bind(process.stderr);
const originalPmbrainHome = process.env.PMBRAIN_HOME;
let configHome: string;

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), 'pmbrain-model-config-'));
  process.env.PMBRAIN_HOME = configHome;
  stub = new StubEngine();
  stderrCapture = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrCapture += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  delete process.env.GBRAIN_MODEL;
  _resetDeprecationWarningsForTest();
});

afterEach(() => {
  process.stderr.write = origWrite;
  if (originalPmbrainHome === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = originalPmbrainHome;
  rmSync(configHome, { recursive: true, force: true });
});

describe('resolveAlias', () => {
  test('built-in aliases resolve to full ids', async () => {
    expect(await resolveAlias(null, 'opus')).toBe(DEFAULT_ALIASES.opus);
    expect(await resolveAlias(null, 'sonnet')).toBe(DEFAULT_ALIASES.sonnet);
    expect(await resolveAlias(null, 'haiku')).toBe(DEFAULT_ALIASES.haiku);
  });

  test('unknown alias passes through (treats as full id)', async () => {
    expect(await resolveAlias(null, 'claude-experimental-9000')).toBe('claude-experimental-9000');
  });

  test('user-defined alias overrides built-in', async () => {
    stub.set('models.aliases.opus', 'claude-opus-4-7-1m');
    expect(await resolveAlias(stub as never, 'opus')).toBe('claude-opus-4-7-1m');
  });

  test('cycle in aliases breaks at depth 2', async () => {
    stub.set('models.aliases.a', 'b');
    stub.set('models.aliases.b', 'a');
    const result = await resolveAlias(stub as never, 'a');
    expect(typeof result).toBe('string');
  });
});

describe('resolveModel — 6-tier precedence', () => {
  test('CLI flag wins over everything', async () => {
    stub.set('models.dream.synthesize', 'sonnet');
    stub.set('models.default', 'opus');
    process.env.GBRAIN_MODEL = 'haiku';
    const m = await resolveModel(stub as never, {
      cliFlag: 'gemini',
      configKey: 'models.dream.synthesize',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.gemini);
  });

  test('new-key config wins over deprecated key, deprecated key wins over default', async () => {
    stub.set('models.dream.synthesize', 'opus');
    stub.set('dream.synthesize.model', 'sonnet');
    stub.set('models.default', 'haiku');
    const m = await resolveModel(stub as never, {
      configKey: 'models.dream.synthesize',
      deprecatedConfigKey: 'dream.synthesize.model',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.opus);
    expect(stderrCapture).toContain('deprecated config "dream.synthesize.model" ignored');
  });

  test('deprecated key honored when new key absent (with warning)', async () => {
    stub.set('dream.synthesize.model', 'opus');
    const m = await resolveModel(stub as never, {
      configKey: 'models.dream.synthesize',
      deprecatedConfigKey: 'dream.synthesize.model',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.opus);
    expect(stderrCapture).toContain('deprecated config "dream.synthesize.model" honored');
  });

  test('global default used when per-key keys absent', async () => {
    stub.set('models.default', 'opus');
    const m = await resolveModel(stub as never, {
      configKey: 'models.dream.synthesize',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.opus);
  });

  test('env var used when no config set', async () => {
    process.env.GBRAIN_MODEL = 'haiku';
    const m = await resolveModel(stub as never, {
      configKey: 'models.dream.synthesize',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.haiku);
  });

  test('hardcoded fallback last', async () => {
    const m = await resolveModel(stub as never, {
      configKey: 'models.dream.synthesize',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.sonnet);
  });

  test('deprecation warning fires once per process per key', async () => {
    stub.set('dream.synthesize.model', 'opus');
    await resolveModel(stub as never, {
      configKey: 'models.dream.synthesize',
      deprecatedConfigKey: 'dream.synthesize.model',
      fallback: 'sonnet',
    });
    const firstWarn = stderrCapture;
    stderrCapture = '';
    await resolveModel(stub as never, {
      configKey: 'models.dream.synthesize',
      deprecatedConfigKey: 'dream.synthesize.model',
      fallback: 'sonnet',
    });
    expect(firstWarn).toContain('deprecated config');
    expect(stderrCapture).toBe('');
  });
});

describe('resolveModel — PMBrain tier system', () => {
  test('tier override beats models.default in advanced mode', async () => {
    stub.set('models.default', 'opus');
    stub.set('models.tier.reasoning', 'haiku');
    const m = await resolveModel(stub as never, {
      tier: 'reasoning',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.haiku);
  });

  test('config.json model routing wins over stale database model settings', async () => {
    saveConfig({
      engine: 'pglite',
      models: {
        propose_takes: 'deepseek:deepseek-v4-flash',
      },
      'models.default': 'deepseek:deepseek-v4-flash',
    });
    stub.set('models.propose_takes', 'mimo:mimo-v2.5-pro');
    stub.set('models.default', 'openai:gpt-5.2');

    const resolved = await resolveModelDetailed(stub as never, {
      configKey: 'models.propose_takes',
      tier: 'reasoning',
      fallback: 'sonnet',
    });

    expect(resolved.model).toBe('deepseek:deepseek-v4-flash');
    expect(resolved.source).toBe('models.propose_takes');
  });

  test('migrates a legacy database-only model setting into config.json on first read', async () => {
    saveConfig({ engine: 'pglite' });
    stub.set('models.propose_takes', 'mimo:mimo-v2.5-pro');

    const resolved = await resolveModelDetailed(stub as never, {
      configKey: 'models.propose_takes',
      tier: 'reasoning',
      fallback: 'sonnet',
    });

    expect(resolved.model).toBe('mimo:mimo-v2.5-pro');
    expect(readFileConfigValue(loadConfigFileOnly(), 'models.propose_takes')).toBe('mimo:mimo-v2.5-pro');
    await expect(stub.getConfig('models.propose_takes')).resolves.toBeNull();
  });

  test('detailed resolution reports model source without changing simple mode', async () => {
    stub.set('models.default', 'openai:gpt-5.2');
    const resolved = await resolveModelDetailed(stub as never, {
      tier: 'reasoning',
      fallback: 'sonnet',
    });
    expect(resolved.model).toBe('openai:gpt-5.2');
    expect(resolved.source).toBe('models.default');
    expect(resolved.provider_id).toBe('openai');
    expect(resolved.fallback_used).toBe(false);
  });

  test('models.tier.<tier> beats env + fallback', async () => {
    stub.set('models.tier.reasoning', 'opus');
    process.env.GBRAIN_MODEL = 'haiku';
    const m = await resolveModel(stub as never, {
      tier: 'reasoning',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.opus);
  });

  test('Dream subagent phases fall back from subagent tier to reasoning tier before default', async () => {
    stub.set('models.default', 'deepseek:deepseek-chat');
    stub.set('models.tier.reasoning', 'openai:gpt-5.2');
    const resolved = await resolveDreamModel(stub as never, { phase: 'synthesize' });
    expect(resolved.model).toBe('openai:gpt-5.2');
    expect(resolved.source).toBe('models.tier.reasoning');
    expect(resolved.tier).toBe('subagent');
  });

  test('TIER_DEFAULTS wins over caller fallback when no override', async () => {
    const m = await resolveModel(stub as never, {
      tier: 'reasoning',
      fallback: 'haiku',
    });
    expect(m).toBe(TIER_DEFAULTS.reasoning);
  });

  test('v0.38 D7: tier.subagent accepts non-Anthropic models that support tools (with cost warn)', async () => {
    // Pre-v0.38 the resolver hard-fell-back to TIER_DEFAULTS.subagent for any
    // non-Anthropic model. v0.38 (D6/D7) replaces that with a capability check:
    // OpenAI/Gemini/etc. support tools → resolved unchanged + warn about
    // missing prompt caching (cost regression on long loops, not a refusal).
    stub.set('models.default', 'openai:gpt-5.2');
    const m = await resolveModel(stub as never, {
      tier: 'subagent',
      fallback: 'sonnet',
    });
    expect(m).toBe('openai:gpt-5.2');
    expect(stderrCapture).toContain('caching');
  });

  test('v0.38 D7: tier.subagent rejects unknown providers (falls back to default)', async () => {
    // Unknown providers fail the capability check (verdict='unknown'); the
    // resolver falls back to TIER_DEFAULTS.subagent rather than burn money on
    // an unverified model.
    stub.set('models.tier.subagent', 'madeup-provider:weird-model');
    const m = await resolveModel(stub as never, {
      tier: 'subagent',
      fallback: 'sonnet',
    });
    expect(m).toBe(TIER_DEFAULTS.subagent);
    expect(stderrCapture).toContain('tier.subagent');
  });

  test('tier.subagent accepts explicit Anthropic override', async () => {
    stub.set('models.tier.subagent', 'anthropic:claude-opus-4-7');
    const m = await resolveModel(stub as never, {
      tier: 'subagent',
      fallback: 'sonnet',
    });
    expect(m).toBe('anthropic:claude-opus-4-7');
    expect(stderrCapture).toBe('');
  });

  test('isAnthropicProvider matches provider-prefixed and bare claude-* ids', () => {
    expect(isAnthropicProvider('anthropic:claude-sonnet-4-6')).toBe(true);
    expect(isAnthropicProvider('claude-opus-4-7')).toBe(true);
    expect(isAnthropicProvider('openai:gpt-5.5')).toBe(false);
    expect(isAnthropicProvider('gemini-3-pro')).toBe(false);
    expect(isAnthropicProvider('')).toBe(false);
  });

  test('v0.41.20.0: isAnthropicProvider classifies slash-form (subagent-guard fix)', () => {
    // Pre-fix: 'anthropic/claude-sonnet-4-6' had no colon and didn't start
    // with 'claude-' (started with 'anthropic') → returned false → silent
    // subagent-guard bypass → fall back to TIER_DEFAULTS.subagent without
    // honoring the user's explicit slash-form config.
    expect(isAnthropicProvider('anthropic/claude-sonnet-4-6')).toBe(true);
    expect(isAnthropicProvider('anthropic/claude-opus-4-7')).toBe(true);
    // Non-Anthropic slash forms STILL return false (don't accidentally
    // widen the guard).
    expect(isAnthropicProvider('openai/gpt-5')).toBe(false);
    expect(isAnthropicProvider('google/gemini-3-pro')).toBe(false);
  });

  test('alias-chain conflict: forward + reverse for same id (Codex F6)', async () => {
    // Codex F6: if both forward and reverse aliases exist, depth cap (2)
    // prevents infinite loop. Canonicalization is deterministic — terminates
    // and returns a valid string, no NaN/undefined fall-through.
    stub.set('models.aliases.claude-sonnet-4-6', 'claude-sonnet-5');
    stub.set('models.aliases.claude-sonnet-5', 'claude-sonnet-4-6');
    const result = await resolveAlias(stub as never, 'claude-sonnet-4-6');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
