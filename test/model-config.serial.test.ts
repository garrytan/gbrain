/**
 * v0.28: tests for the unified model resolver. Pure-function-style tests using
 * a tiny stub engine — no DB, no PGLite, no Postgres needed.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  resolveModel,
  resolveAlias,
  DEFAULT_ALIASES,
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
