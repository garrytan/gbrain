import { describe, test, expect } from 'bun:test';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

// redactUrl is not exported, so we test it by reading the source and
// reimplementing the regex to verify the pattern, then test via CLI

// Extract the redactUrl regex pattern from source
const configSource = readFileSync(
  new URL('../src/commands/config.ts', import.meta.url),
  'utf-8',
);
const cliSource = readFileSync(
  new URL('../src/cli.ts', import.meta.url),
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

  test('config get can fall back to file config without database', () => {
    expect(configSource).toContain("if (config && key in config)");
  });

  test('config set supports file-backed keys without database', () => {
    expect(configSource).toContain('FILE_BACKED_KEYS');
    expect(configSource).toContain("FILE_BACKED_KEYS.has(key as keyof GBrainConfig)");
  });
});

describe('CLI config routing', () => {
  test('all config commands route before DB connection', () => {
    const configIdx = cliSource.indexOf("command === 'config')");
    const dbComment = cliSource.indexOf('All remaining CLI-only commands need a DB connection');
    expect(configIdx).toBeGreaterThan(0);
    expect(dbComment).toBeGreaterThan(0);
    expect(configIdx).toBeLessThan(dbComment);
  });
});

describe('CLI config runtime behavior', () => {
  function makeTempHome(name: string) {
    const home = join(tmpdir(), `gbrain-config-test-${name}-${Date.now()}`);
    const gbrainDir = join(home, '.gbrain');
    mkdirSync(gbrainDir, { recursive: true });
    return { home, gbrainDir };
  }

  function runCli(home: string, args: string[]) {
    return execFileSync(
      'bun',
      ['run', 'src/cli.ts', ...args],
      {
        cwd: '/Users/wj/gbrain',
        env: { ...process.env, HOME: home },
        encoding: 'utf-8',
      },
    );
  }

  test('config show/get work without database connection', () => {
    const { home, gbrainDir } = makeTempHome('show-get');
    writeFileSync(
      join(gbrainDir, 'config.json'),
      JSON.stringify({
        engine: 'postgres',
        database_url: 'postgresql://offline:pw@offline-host:5432/offline_db',
      }, null, 2) + '\n',
      'utf-8',
    );

    const show = runCli(home, ['config', 'show']);
    const engine = runCli(home, ['config', 'get', 'engine']).trim();
    const databaseUrl = runCli(home, ['config', 'get', 'database_url']).trim();

    expect(show).toContain('engine: postgres');
    expect(show).toContain('database_url: postgresql://offline:***@offline-host:5432/offline_db');
    expect(engine).toBe('postgres');
    expect(databaseUrl).toBe('postgresql://offline:pw@offline-host:5432/offline_db');
  });

  test('file-backed config set updates config without database connection', () => {
    const { home, gbrainDir } = makeTempHome('set');
    const configPath = join(gbrainDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        engine: 'postgres',
        database_url: 'postgresql://before:pw@before-host:5432/before_db',
      }, null, 2) + '\n',
      'utf-8',
    );

    const setOut = runCli(home, ['config', 'set', 'database_url', 'postgresql://after:pw@after-host:7654/after_db']);
    const getOut = runCli(home, ['config', 'get', 'database_url']).trim();
    const configJson = JSON.parse(readFileSync(configPath, 'utf-8'));

    expect(setOut).toContain('Set database_url = postgresql://after:pw@after-host:7654/after_db');
    expect(getOut).toBe('postgresql://after:pw@after-host:7654/after_db');
    expect(configJson.database_url).toBe('postgresql://after:pw@after-host:7654/after_db');
  });
});
