import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { configDir, configPath, noBrainConfiguredMessage } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

const CLI = join(__dirname, '..', 'src', 'cli.ts');

function envFor(envOverrides: Record<string, string | undefined>): Record<string, string> {
  const env = { ...process.env, ...envOverrides } as Record<string, string | undefined>;
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  return env as Record<string, string>;
}

function runCliWithEnv(envOverrides: Record<string, string | undefined>): { exitCode: number; stderr: string } {
  try {
    execFileSync('bun', ['run', CLI, 'stats'], {
      env: envFor(envOverrides),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stderr: '' };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stderr: err.stderr?.toString?.() ?? '',
    };
  }
}

function readConfigPathsWithEnv(envOverrides: Record<string, string | undefined>): { dir: string; path: string } {
  const stdout = execFileSync('bun', ['-e', `
    import { configDir, configPath } from './src/core/config.ts';
    console.log(JSON.stringify({ dir: configDir(), path: configPath() }));
  `], {
    cwd: join(__dirname, '..'),
    env: envFor(envOverrides),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout);
}

describe('no brain configured diagnostic', () => {
  test('prints resolved config path and Hermes profile HOME hint', async () => {
    const result = runCliWithEnv({
      HOME: '/home/operator/.hermes/profiles/ops-watch/home',
      GBRAIN_HOME: undefined,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No brain configured.');
    expect(result.stderr).toContain('Expected config: /home/operator/.hermes/profiles/ops-watch/home/.gbrain/config.json');
    expect(result.stderr).toContain('HOME=/home/operator');
    expect(result.stderr).toContain('GBRAIN_HOME=/home/operator');
    expect(result.stderr).toContain('GBRAIN_HOME=/home/operator/.gbrain is also accepted');
    expect(result.stderr).toContain('Run: gbrain init');
  });

  test('accepts GBRAIN_HOME pointing directly at a .gbrain directory', async () => {
    await withEnv({
      HOME: '/home/operator',
      GBRAIN_HOME: '/home/operator/.gbrain',
      DATABASE_URL: undefined,
      GBRAIN_DATABASE_URL: undefined,
    }, async () => {
      const msg = noBrainConfiguredMessage();

      expect(configPath()).toBe('/home/operator/.gbrain/config.json');
      expect(msg).toContain('Expected config: /home/operator/.gbrain/config.json');
      expect(msg).toContain('GBRAIN_HOME points directly at a .gbrain directory; this is accepted.');
      expect(msg).toContain('GBRAIN_HOME=/home/operator');
    });
  });

  test('default no-config hint does not reject direct .gbrain overrides', async () => {
    await withEnv({
      GBRAIN_HOME: undefined,
      DATABASE_URL: undefined,
      GBRAIN_DATABASE_URL: undefined,
    }, async () => {
      const msg = noBrainConfiguredMessage();
      expect(msg).toContain('or to the .gbrain directory itself');
      expect(msg).not.toContain('not the .gbrain directory itself');
    });
  });

  test('keeps absolute root absolute when normalizing trailing separators', async () => {
    await withEnv({
      HOME: '/home/operator',
      GBRAIN_HOME: '/',
      DATABASE_URL: undefined,
      GBRAIN_DATABASE_URL: undefined,
    }, async () => {
      expect(configDir()).toBe('/.gbrain');
      expect(configPath()).toBe('/.gbrain/config.json');
    });
  });

  test('normalizes trailing separators without double-appending .gbrain', async () => {
    await withEnv({
      HOME: '/home/operator',
      GBRAIN_HOME: '/home/operator/.gbrain///',
      DATABASE_URL: undefined,
      GBRAIN_DATABASE_URL: undefined,
    }, async () => {
      expect(configDir()).toBe('/home/operator/.gbrain');
      expect(configPath()).toBe('/home/operator/.gbrain/config.json');
    });
  });

  test('falls back from Hermes profile HOME to operator .gbrain when present', async () => {
    const operatorHome = join(tmpdir(), `gbrain-hermes-home-${process.pid}-${Date.now()}`);
    const profileHome = join(operatorHome, '.hermes', 'profiles', 'ops-watch', 'home');
    try {
      mkdirSync(join(operatorHome, '.gbrain'), { recursive: true });
      mkdirSync(profileHome, { recursive: true });
      writeFileSync(join(operatorHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: '/tmp/brain.pglite' }));

      const paths = readConfigPathsWithEnv({
        HOME: profileHome,
        GBRAIN_HOME: undefined,
        DATABASE_URL: undefined,
        GBRAIN_DATABASE_URL: undefined,
      });
      expect(paths.dir).toBe(join(operatorHome, '.gbrain'));
      expect(paths.path).toBe(join(operatorHome, '.gbrain', 'config.json'));
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
    }
  });
});
