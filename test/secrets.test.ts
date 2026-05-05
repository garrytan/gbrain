import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// All getSecret tests run with GBRAIN_HOME pointed at a fresh tempdir so the
// resolver reads from a controlled config. We mutate process.env (GBRAIN_HOME +
// the three API key vars) and restore everything in afterEach. Mirrors the
// save-restore pattern from test/doctor.test.ts:59–75.

interface SavedEnv {
  GBRAIN_HOME?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GROQ_API_KEY?: string;
}

let saved: SavedEnv = {};
let tempHome: string | null = null;

function snapshotEnv(): SavedEnv {
  return {
    GBRAIN_HOME: process.env.GBRAIN_HOME,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };
}

function restoreEnv(s: SavedEnv) {
  for (const key of ['GBRAIN_HOME', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY'] as const) {
    if (s[key] === undefined) delete process.env[key];
    else process.env[key] = s[key]!;
  }
}

function setupTempHome(configBody: object | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-secrets-test-'));
  process.env.GBRAIN_HOME = dir;
  if (configBody !== null) {
    mkdirSync(join(dir, '.gbrain'), { recursive: true });
    writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify(configBody), { mode: 0o600 });
  }
  return dir;
}

beforeEach(() => {
  saved = snapshotEnv();
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GROQ_API_KEY;
});

afterEach(async () => {
  const { clearSecretsCache } = await import('../src/core/secrets.ts');
  clearSecretsCache();
  if (tempHome) {
    try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    tempHome = null;
  }
  restoreEnv(saved);
});

describe('getSecret — env fallback', () => {
  test('returns env value when no command configured', async () => {
    tempHome = setupTempHome({ engine: 'pglite', database_path: '/tmp/x.pglite' });
    process.env.OPENAI_API_KEY = 'sk-from-env';
    const { getSecret } = await import('../src/core/secrets.ts');
    expect(getSecret('OPENAI_API_KEY')).toBe('sk-from-env');
  });

  test('returns undefined when no command and no env', async () => {
    tempHome = setupTempHome({ engine: 'pglite', database_path: '/tmp/x.pglite' });
    const { getSecret } = await import('../src/core/secrets.ts');
    expect(getSecret('ANTHROPIC_API_KEY')).toBeUndefined();
  });

  test('returns undefined when no config file exists at all', async () => {
    tempHome = setupTempHome(null);
    const { getSecret } = await import('../src/core/secrets.ts');
    expect(getSecret('GROQ_API_KEY')).toBeUndefined();
  });
});

describe('getSecret — command resolution', () => {
  test('runs configured command and returns trimmed stdout', async () => {
    tempHome = setupTempHome({
      engine: 'pglite',
      database_path: '/tmp/x.pglite',
      secrets: { openai_api_key_command: 'printf "sk-from-command\\n"' },
    });
    const { getSecret } = await import('../src/core/secrets.ts');
    expect(getSecret('OPENAI_API_KEY')).toBe('sk-from-command');
  });

  test('command wins over env when both set', async () => {
    tempHome = setupTempHome({
      engine: 'pglite',
      database_path: '/tmp/x.pglite',
      secrets: { anthropic_api_key_command: 'echo cmd-wins' },
    });
    process.env.ANTHROPIC_API_KEY = 'env-loses';
    const { getSecret } = await import('../src/core/secrets.ts');
    expect(getSecret('ANTHROPIC_API_KEY')).toBe('cmd-wins');
  });

  test('throws loudly when command exits non-zero, includes stderr in message', async () => {
    tempHome = setupTempHome({
      engine: 'pglite',
      database_path: '/tmp/x.pglite',
      secrets: { groq_api_key_command: 'sh -c "echo keychain-locked >&2; exit 7"' },
    });
    const { getSecret } = await import('../src/core/secrets.ts');
    expect(() => getSecret('GROQ_API_KEY')).toThrow(/GROQ_API_KEY resolver command failed/);
    expect(() => getSecret('GROQ_API_KEY')).toThrow(/keychain-locked/);
  });

  test('throws when command resolves to empty output', async () => {
    tempHome = setupTempHome({
      engine: 'pglite',
      database_path: '/tmp/x.pglite',
      secrets: { openai_api_key_command: 'printf ""' },
    });
    const { getSecret } = await import('../src/core/secrets.ts');
    expect(() => getSecret('OPENAI_API_KEY')).toThrow(/returned empty output/);
  });

  test('treats whitespace-only command string as not configured (falls through to env)', async () => {
    tempHome = setupTempHome({
      engine: 'pglite',
      database_path: '/tmp/x.pglite',
      secrets: { openai_api_key_command: '   ' },
    });
    process.env.OPENAI_API_KEY = 'sk-env-fallback';
    const { getSecret } = await import('../src/core/secrets.ts');
    expect(getSecret('OPENAI_API_KEY')).toBe('sk-env-fallback');
  });
});

describe('getSecret — caching', () => {
  test('runs command exactly once for repeated reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-secrets-cache-'));
    tempHome = dir;
    const counterFile = join(dir, 'counter');
    process.env.GBRAIN_HOME = dir;
    mkdirSync(join(dir, '.gbrain'), { recursive: true });
    writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite',
      database_path: '/tmp/x.pglite',
      secrets: {
        openai_api_key_command: `sh -c 'echo run >> "${counterFile}"; printf cached-value'`,
      },
    }));

    const { getSecret } = await import('../src/core/secrets.ts');
    expect(getSecret('OPENAI_API_KEY')).toBe('cached-value');
    expect(getSecret('OPENAI_API_KEY')).toBe('cached-value');
    expect(getSecret('OPENAI_API_KEY')).toBe('cached-value');

    expect(existsSync(counterFile)).toBe(true);
    const runs = readFileSync(counterFile, 'utf8').trim().split('\n').filter(Boolean);
    expect(runs.length).toBe(1);
  });

  test('clearSecretsCache forces re-resolution on next read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-secrets-clear-'));
    tempHome = dir;
    const counterFile = join(dir, 'counter');
    process.env.GBRAIN_HOME = dir;
    mkdirSync(join(dir, '.gbrain'), { recursive: true });
    writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite',
      database_path: '/tmp/x.pglite',
      secrets: {
        anthropic_api_key_command: `sh -c 'echo run >> "${counterFile}"; printf cached-value'`,
      },
    }));

    const { getSecret, clearSecretsCache } = await import('../src/core/secrets.ts');
    getSecret('ANTHROPIC_API_KEY');
    clearSecretsCache();
    getSecret('ANTHROPIC_API_KEY');

    const runs = readFileSync(counterFile, 'utf8').trim().split('\n').filter(Boolean);
    expect(runs.length).toBe(2);
  });
});

describe('resolveAllConfiguredSecrets', () => {
  test('returns one entry per secret name, marks env-only as not configured', async () => {
    tempHome = setupTempHome({ engine: 'pglite', database_path: '/tmp/x.pglite' });
    process.env.OPENAI_API_KEY = 'sk-env';
    const { resolveAllConfiguredSecrets } = await import('../src/core/secrets.ts');
    const results = resolveAllConfiguredSecrets();
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.configured).toBe(false);
      expect(r.resolved).toBe(false);
    }
  });

  test('reports per-key resolution success when commands work', async () => {
    tempHome = setupTempHome({
      engine: 'pglite',
      database_path: '/tmp/x.pglite',
      secrets: {
        openai_api_key_command: 'echo openai-ok',
        anthropic_api_key_command: 'echo anthropic-ok',
      },
    });
    const { resolveAllConfiguredSecrets } = await import('../src/core/secrets.ts');
    const results = resolveAllConfiguredSecrets();
    const openai = results.find(r => r.name === 'OPENAI_API_KEY')!;
    const anthropic = results.find(r => r.name === 'ANTHROPIC_API_KEY')!;
    const groq = results.find(r => r.name === 'GROQ_API_KEY')!;
    expect(openai.configured).toBe(true);
    expect(openai.resolved).toBe(true);
    expect(openai.error).toBeUndefined();
    expect(anthropic.configured).toBe(true);
    expect(anthropic.resolved).toBe(true);
    expect(groq.configured).toBe(false);
    expect(groq.resolved).toBe(false);
  });

  test('reports per-key failure with error message when command fails', async () => {
    tempHome = setupTempHome({
      engine: 'pglite',
      database_path: '/tmp/x.pglite',
      secrets: {
        openai_api_key_command: 'sh -c "echo nope >&2; exit 2"',
        anthropic_api_key_command: 'echo good',
      },
    });
    const { resolveAllConfiguredSecrets } = await import('../src/core/secrets.ts');
    const results = resolveAllConfiguredSecrets();
    const openai = results.find(r => r.name === 'OPENAI_API_KEY')!;
    const anthropic = results.find(r => r.name === 'ANTHROPIC_API_KEY')!;
    expect(openai.resolved).toBe(false);
    expect(openai.error).toMatch(/resolver command failed/);
    expect(openai.error).toMatch(/nope/);
    expect(anthropic.resolved).toBe(true);
    expect(anthropic.error).toBeUndefined();
  });
});

describe('subprocess isolation contract', () => {
  test('resolver does not write resolved value to process.env', async () => {
    tempHome = setupTempHome({
      engine: 'pglite',
      database_path: '/tmp/x.pglite',
      secrets: { openai_api_key_command: 'echo never-in-env' },
    });
    const { getSecret } = await import('../src/core/secrets.ts');
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    const value = getSecret('OPENAI_API_KEY');
    expect(value).toBe('never-in-env');
    // Critical contract: the resolver must NEVER mutate process.env. If it did,
    // `gbrain serve` would leak the secret to every spawned child via inherited env.
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe('doctor secret_resolution check is wired', () => {
  test('doctor.ts source references the secret_resolution check + resolveAllConfiguredSecrets', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    expect(source).toContain("name: 'secret_resolution'");
    expect(source).toContain('resolveAllConfiguredSecrets');
  });
});
