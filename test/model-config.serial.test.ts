/**
 * v0.28: tests for the unified model resolver. Pure-function-style tests using
 * a tiny stub engine — no DB, no PGLite, no Postgres needed.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  resolveModel,
  resolveAlias,
  DEFAULT_ALIASES,
  TIER_DEFAULTS,
  isAnthropicProvider,
  _resetDeprecationWarningsForTest,
} from '../src/core/model-config.ts';

class StubEngine {
  readonly kind = 'pglite' as const;
  private cfg = new Map<string, string>();
  set(key: string, value: string) { this.cfg.set(key, value); }
  async getConfig(key: string) { return this.cfg.get(key) ?? null; }
  // unused stubs to satisfy the BrainEngine duck-type at the resolveModel boundary
  async setConfig() {}
}

let stub: StubEngine;
let stderrCapture: string;
const origWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
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

describe('resolveModel — v0.31.12 tier system', () => {
  test('models.default beats tier override', async () => {
    stub.set('models.default', 'opus');
    stub.set('models.tier.reasoning', 'haiku');
    const m = await resolveModel(stub as never, {
      tier: 'reasoning',
      fallback: 'sonnet',
    });
    expect(m).toBe(DEFAULT_ALIASES.opus);
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

  test('TIER_DEFAULTS wins over caller fallback when no override', async () => {
    const m = await resolveModel(stub as never, {
      tier: 'reasoning',
      fallback: 'haiku',
    });
    expect(m).toBe(TIER_DEFAULTS.reasoning);
  });

  test('tier.subagent falls back to TIER_DEFAULTS.subagent when models.default is non-Anthropic', async () => {
    stub.set('models.default', 'openai:gpt-5.5');
    const m = await resolveModel(stub as never, {
      tier: 'subagent',
      fallback: 'sonnet',
    });
    expect(m).toBe(TIER_DEFAULTS.subagent);
    expect(stderrCapture).toContain('tier.subagent');
    expect(stderrCapture).toContain('non-Anthropic');
    expect(stderrCapture).toContain('models.default');
  });

  test('tier.subagent falls back when explicitly set to non-Anthropic', async () => {
    stub.set('models.tier.subagent', 'openai:gpt-5.5');
    const m = await resolveModel(stub as never, {
      tier: 'subagent',
      fallback: 'sonnet',
    });
    expect(m).toBe(TIER_DEFAULTS.subagent);
    expect(stderrCapture).toContain('models.tier.subagent');
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
