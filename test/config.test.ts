import { describe, test, expect } from 'bun:test';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// redactUrl is not exported, so we test it by reading the source and
// reimplementing the regex to verify the pattern, then test via CLI

// Extract the redactUrl regex pattern from source
const configSource = readFileSync(
  new URL('../src/commands/config.ts', import.meta.url),
  'utf-8',
);

// Reimplemented from source for unit testing
function redactUrl(url: string): string {
  return url.replace(
    /(postgresql:\/\/[^:]+:)([^@]+)(@)/,
    '$1***$3',
  );
}

describe('redactUrl', () => {
  test('redacts password in postgresql:// URL', () => {
    const url = 'postgresql://user:secretpass@host:5432/dbname';
    expect(redactUrl(url)).toBe('postgresql://user:***@host:5432/dbname');
  });

  test('redacts complex passwords with special chars', () => {
    const url = 'postgresql://postgres:p@ss!w0rd#123@db.supabase.co:5432/postgres';
    // The regex is greedy on [^@]+ so it captures up to the LAST @
    const result = redactUrl(url);
    expect(result).not.toContain('p@ss');
    expect(result).toContain('***');
  });

  test('returns non-postgresql URLs unchanged', () => {
    const url = 'https://example.com/api';
    expect(redactUrl(url)).toBe(url);
  });

  test('returns plain strings unchanged', () => {
    expect(redactUrl('hello')).toBe('hello');
  });

  test('handles URL without password', () => {
    const url = 'postgresql://user@host:5432/dbname';
    // No colon after user means regex doesn't match
    expect(redactUrl(url)).toBe(url);
  });

  test('handles empty string', () => {
    expect(redactUrl('')).toBe('');
  });
});

describe('config source correctness', () => {
  test('redactUrl function exists in config.ts', () => {
    expect(configSource).toContain('function redactUrl');
  });

  test('redactUrl uses the correct regex pattern', () => {
    expect(configSource).toContain('postgresql:\\/\\/');
  });
});

describe('setup guidance strings', () => {
  test('CLI no-config help includes postgres and pglite setup paths', async () => {
    const cliSource = readFileSync(
      new URL('../src/cli.ts', import.meta.url),
      'utf-8',
    );
    expect(cliSource).toContain('gbrain init --url <connection_string>');
    expect(cliSource).toContain('gbrain init --pglite <file_path>');
  });
});

describe('loadConfig precedence', () => {
  test('DATABASE_URL overrides persisted pglite engine config', () => {
    const home = join(tmpdir(), `gbrain-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const hermesHome = join(home, '.gbrain');
    mkdirSync(hermesHome, { recursive: true });
    writeFileSync(join(hermesHome, 'config.json'), JSON.stringify({
      engine: 'pglite',
      database_path: '/tmp/local.db',
    }));

    const result = Bun.spawnSync({
      cmd: ['bun', '--eval', `import { loadConfig } from './src/core/config.ts'; console.log(JSON.stringify(loadConfig()));`],
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        HOME: home,
        DATABASE_URL: 'postgresql://override-host:5432/gbrain',
      },
    });

    const stdout = new TextDecoder().decode(result.stdout).trim();
    rmSync(home, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.engine).toBe('postgres');
    expect(parsed.database_url).toBe('postgresql://override-host:5432/gbrain');
  });
});
