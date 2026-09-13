import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { listRecipes } from '../src/core/ai/recipes/index.ts';
import { keylessBrainEnv, PROVIDER_ENV_KEYS } from './helpers/provider-env.ts';
import { cliDiagnostic, fixtureDiagnostic, toolDiagnostic } from './helpers/fixture-diagnostics.ts';

describe('keyless fixture environment', () => {
  test('covers every recipe credential and compatibility endpoint', () => {
    const registered = listRecipes().flatMap(recipe => [
      ...(recipe.auth_env?.required ?? []), ...(recipe.auth_env?.optional ?? []),
    ]);
    const required = new Set([...registered, 'GEMINI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL']);
    expect([...required].filter(key => !PROVIDER_ENV_KEYS.includes(key as typeof PROVIDER_ENV_KEYS[number]))).toEqual([]);
  });

  test.each([...PROVIDER_ENV_KEYS])('removes inherited %s without touching its parent', key => {
    const parent = { [key]: 'fixture-value', UNRELATED_API_KEY: 'preserve', PATH: '/fixture/bin' };
    const env = keylessBrainEnv(parent, '/fixture/home');
    expect(env[key]).toBeUndefined();
    expect(parent[key]).toBe('fixture-value');
    expect(env.UNRELATED_API_KEY).toBe('preserve');
    expect(env.PATH).toBe('/fixture/bin');
    expect(env.HOME).toBe('/fixture/home');
    expect(env.GBRAIN_HOME).toBe('/fixture/home');
  });

  test('explicit overrides are last and database policy belongs to the fixture', () => {
    const parent = { OPENAI_API_KEY: 'ambient', DATABASE_URL: 'test-url', GBRAIN_DATABASE_URL: 'other-url' };
    const env = keylessBrainEnv(parent, '/fixture/home', { OPENAI_API_KEY: 'explicit-test-key', GBRAIN_DATABASE_URL: undefined });
    expect(env.OPENAI_API_KEY).toBe('explicit-test-key');
    expect(env.DATABASE_URL).toBe('test-url');
    expect(env.GBRAIN_DATABASE_URL).toBeUndefined();
    expect(parent.GBRAIN_DATABASE_URL).toBe('other-url');
  });

  test('no-env-file prevents cwd .env from restoring stripped provider state in children', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-provider-env-'));
    try {
      writeFileSync(join(home, '.env'), 'OPENAI_API_KEY=synthetic-cwd-key\n');
      const env = keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined });
      const probe = 'process.stdout.write(String(Boolean(process.env.OPENAI_API_KEY)))';
      const ordinary = spawnSync(process.execPath, ['--eval', probe], { cwd: home, env, encoding: 'utf8' });
      const isolated = spawnSync(process.execPath, ['--no-env-file', '--eval', probe], { cwd: home, env, encoding: 'utf8' });
      expect(ordinary.status).toBe(0);
      expect(ordinary.stdout).toBe('true');
      expect(isolated.status).toBe(0);
      expect(isolated.stdout).toBe('false');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('preload strips all provider state by default and honors the explicit live-lane opt-in', () => {
    const preload = join(import.meta.dir, 'helpers/provider-keys-preload.ts');
    const probe = `await import(${JSON.stringify(preload)}); process.stdout.write(JSON.stringify(${JSON.stringify(PROVIDER_ENV_KEYS)}.map(key => Boolean(process.env[key]))))`;
    const synthetic = Object.fromEntries(PROVIDER_ENV_KEYS.map(key => [key, 'synthetic-fixture-value']));
    for (const keep of ['0', '1']) {
      const result = spawnSync(process.execPath, ['--no-env-file', '--eval', probe], {
        cwd: tmpdir(), encoding: 'utf8',
        env: { ...process.env, ...synthetic, GBRAIN_TEST_KEEP_PROVIDER_KEYS: keep },
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(PROVIDER_ENV_KEYS.map(() => keep === '1'));
    }
  });
});

describe('fixture failure diagnostics', () => {
  test('keeps operation, exit and error code while redacting credentials before truncation', () => {
    const detail = 'code=permission_denied gbrain_cs_syntheticsecret Bearer synthetic-bearer ' +
      'client_secret=synthetic-secret {"access_token":"synthetic-token"} explicit-fixture-secret sk-synthetic-provider';
    const diagnostic = cliDiagnostic('put', { exitCode: 1, stdout: detail, stderr: '' }, ['explicit-fixture-secret']);
    expect(diagnostic).toContain('put: exit=1');
    expect(diagnostic).toContain('code=permission_denied');
    for (const secret of ['syntheticsecret', 'synthetic-bearer', 'synthetic-secret', 'synthetic-token', 'explicit-fixture-secret', 'sk-synthetic-provider']) {
      expect(diagnostic).not.toContain(secret);
    }
    const bounded = fixtureDiagnostic('remember', 'x'.repeat(5000));
    expect(bounded.length).toBeLessThanOrEqual(2000);
    expect(bounded).toContain('[truncated]');
  });

  test('reports tool error text without serializing successful result data', () => {
    expect(toolDiagnostic('remember', { isError: true, content: [{ type: 'text', text: '{"code":"invalid_dimension","error":"expected 1536"}' }] })).toContain('invalid_dimension');
    expect(toolDiagnostic('remember', { content: [{ type: 'text', text: 'private-success-data' }] })).toBe('remember');
  });

  test('warning stderr cannot hide the structured stdout error or crowd out either stream', () => {
    const secret = 'fixture-secret-canary';
    const diagnostic = cliDiagnostic('capture', {
      exitCode: 1,
      stderr: `WARNING_STDERR Bearer warning-token ${secret} ${'w'.repeat(5000)}`,
      stdout: JSON.stringify({ error: 'permission_denied', message: `OPERATION_STDOUT ${secret}`, access_token: 'stdout-token' }),
    }, [secret]);
    expect(diagnostic.startsWith('capture: exit=1 code=permission_denied\n')).toBe(true);
    expect(diagnostic).toContain('stderr:\nWARNING_STDERR');
    expect(diagnostic).toContain('stdout:\n');
    expect(diagnostic).toContain('OPERATION_STDOUT');
    expect(diagnostic).toContain('[truncated]');
    expect(diagnostic.length).toBeLessThanOrEqual(2000);
    for (const canary of [secret, 'warning-token', 'stdout-token']) expect(diagnostic).not.toContain(canary);
  });

  test('structured codes survive long stdout details and JSON-line notices', () => {
    const diagnostic = cliDiagnostic('remember', {
      exitCode: 2,
      stderr: 'stderr warning',
      stdout: `stdout notice\n${JSON.stringify({ error: { message: 'x'.repeat(5000), code: 'invalid_dimension' } })}`,
    });
    expect(diagnostic.startsWith('remember: exit=2 code=invalid_dimension\n')).toBe(true);
    expect(diagnostic).toContain('stderr warning');
    expect(diagnostic).toContain('stdout notice');
    expect(diagnostic).toContain('[truncated]');
    expect(diagnostic.length).toBeLessThanOrEqual(2000);
  });

  test('tool error codes precede long warning content and redact structured secrets', () => {
    const diagnostic = toolDiagnostic('recall', {
      isError: true,
      content: [
        { type: 'text', text: `warning tool-secret-canary ${'x'.repeat(5000)}` },
        { type: 'text', text: JSON.stringify({ error: 'missing_scope', message: 'Requires read', client_secret: 'tool-client-secret' }) },
      ],
    }, ['tool-secret-canary']);
    expect(diagnostic.startsWith('recall: code=missing_scope\n')).toBe(true);
    expect(diagnostic).toContain('[truncated]');
    expect(diagnostic.length).toBeLessThanOrEqual(2000);
    expect(diagnostic).not.toContain('tool-secret-canary');
    expect(diagnostic).not.toContain('tool-client-secret');
    expect(toolDiagnostic('recall', { error: { code: -32603, message: 'Internal error' } })).toStartWith('recall: code=-32603\n');
  });
});
