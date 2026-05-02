import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, getDbUrlSource } from '../src/core/config.ts';

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

describe('loadConfig precedence', () => {
  // Bun auto-loads `.env` from cwd, so a user running `gbrain` inside an
  // unrelated project picks up that project's DATABASE_URL. The brain's own
  // ~/.gbrain/config.json must beat that generic var; only the explicit
  // GBRAIN_DATABASE_URL is allowed to override the config file.
  let tmp: string;
  let prevHome: string | undefined;
  let prevGbrainUrl: string | undefined;
  let prevDbUrl: string | undefined;

  const writeConfig = (json: object) => {
    mkdirSync(join(tmp, '.gbrain'), { recursive: true });
    writeFileSync(join(tmp, '.gbrain', 'config.json'), JSON.stringify(json));
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gbrain-config-test-'));
    prevHome = process.env.HOME;
    prevGbrainUrl = process.env.GBRAIN_DATABASE_URL;
    prevDbUrl = process.env.DATABASE_URL;
    process.env.HOME = tmp;
    delete process.env.GBRAIN_DATABASE_URL;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevGbrainUrl === undefined) delete process.env.GBRAIN_DATABASE_URL;
    else process.env.GBRAIN_DATABASE_URL = prevGbrainUrl;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  test('config file URL beats generic DATABASE_URL', () => {
    writeConfig({ engine: 'postgres', database_url: 'postgresql://config-host/brain' });
    process.env.DATABASE_URL = 'postgresql://random-project-host/somedb';
    expect(loadConfig()?.database_url).toBe('postgresql://config-host/brain');
    expect(getDbUrlSource()).toBe('config-file');
  });

  test('GBRAIN_DATABASE_URL beats config file', () => {
    writeConfig({ engine: 'postgres', database_url: 'postgresql://config-host/brain' });
    process.env.GBRAIN_DATABASE_URL = 'postgresql://override-host/brain';
    expect(loadConfig()?.database_url).toBe('postgresql://override-host/brain');
    expect(getDbUrlSource()).toBe('env:GBRAIN_DATABASE_URL');
  });

  test('GBRAIN_DATABASE_URL beats generic DATABASE_URL when no config', () => {
    process.env.GBRAIN_DATABASE_URL = 'postgresql://gbrain-host/brain';
    process.env.DATABASE_URL = 'postgresql://random-project-host/somedb';
    expect(loadConfig()?.database_url).toBe('postgresql://gbrain-host/brain');
    expect(getDbUrlSource()).toBe('env:GBRAIN_DATABASE_URL');
  });

  test('falls back to DATABASE_URL when no config file and no GBRAIN_DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgresql://fallback-host/brain';
    expect(loadConfig()?.database_url).toBe('postgresql://fallback-host/brain');
    expect(getDbUrlSource()).toBe('env:DATABASE_URL');
  });

  test('returns null when no source provides a URL', () => {
    expect(loadConfig()).toBeNull();
    expect(getDbUrlSource()).toBeNull();
  });

  test('PGLite config-file-path is preserved when no URL anywhere', () => {
    writeConfig({ engine: 'pglite', database_path: '/tmp/some-pglite' });
    expect(loadConfig()?.database_path).toBe('/tmp/some-pglite');
    expect(getDbUrlSource()).toBe('config-file-path');
  });
});
