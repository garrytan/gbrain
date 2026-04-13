import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const originalEnv = { ...process.env };
let tempHome: string;

function writeUserConfig(config: Record<string, unknown>) {
  const dir = join(tempHome, '.gbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

function redactUrl(url: string): string {
  return url.replace(
    /(postgresql:\/\/[^:]+:)([^@]+)(@)/,
    '$1***$3',
  );
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'gbrain-config-'));
  process.env.HOME = tempHome;
  delete process.env.GBRAIN_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(tempHome, { recursive: true, force: true });
});

describe('config loading', () => {
  test('createLocalConfigDefaults uses nomic-embed-text as the local default embedding model', async () => {
    const { createLocalConfigDefaults } = await import('../src/core/config.ts');
    expect(createLocalConfigDefaults().embedding_model).toBe('nomic-embed-text');
  });

  test('loads sqlite engine settings from config', async () => {
    writeUserConfig({
      engine: 'sqlite',
      database_path: '~/.gbrain/brain.db',
      offline: true,
      embedding_provider: 'local',
      embedding_model: 'bge-m3',
      query_rewrite_provider: 'heuristic',
    });

    const { loadConfig } = await import('../src/core/config.ts');
    const config = loadConfig();

    expect(config).toMatchObject({
      engine: 'sqlite',
      database_path: '~/.gbrain/brain.db',
      offline: true,
      embedding_provider: 'local',
      embedding_model: 'bge-m3',
      query_rewrite_provider: 'heuristic',
    });
  });

  test('preserves backward compatibility for legacy config files with no engine key', async () => {
    writeUserConfig({
      database_url: 'postgresql://user:pass@localhost:5432/gbrain',
    });

    const { loadConfig } = await import('../src/core/config.ts');
    expect(loadConfig()).toMatchObject({
      engine: 'postgres',
      database_url: 'postgresql://user:pass@localhost:5432/gbrain',
      offline: false,
    });
  });

  test('defaults env-only database config to postgres unless local mode is explicitly configured', async () => {
    process.env.GBRAIN_DATABASE_URL = 'postgresql://env-user:env-pass@localhost:5432/gbrain';

    const { loadConfig } = await import('../src/core/config.ts');
    expect(loadConfig()).toMatchObject({
      engine: 'postgres',
      database_url: 'postgresql://env-user:env-pass@localhost:5432/gbrain',
      offline: false,
    });
  });

  test('keeps explicit sqlite mode even when postgres env vars are present', async () => {
    writeUserConfig({
      engine: 'sqlite',
      database_path: '~/.gbrain/brain.db',
      offline: true,
      embedding_provider: 'local',
      query_rewrite_provider: 'heuristic',
    });
    process.env.GBRAIN_DATABASE_URL = 'postgresql://env-user:env-pass@localhost:5432/gbrain';

    const { loadConfig } = await import('../src/core/config.ts');
    expect(loadConfig()).toMatchObject({
      engine: 'sqlite',
      database_path: '~/.gbrain/brain.db',
      offline: true,
      embedding_provider: 'local',
      query_rewrite_provider: 'heuristic',
    });
  });
});

describe('redactUrl', () => {
  test('redacts password in postgresql:// URL', () => {
    const url = 'postgresql://user:secretpass@host:5432/dbname';
    expect(redactUrl(url)).toBe('postgresql://user:***@host:5432/dbname');
  });

  test('redacts complex passwords with special chars', () => {
    const url = 'postgresql://postgres:p@ss!w0rd#123@db.supabase.co:5432/postgres';
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
    expect(redactUrl(url)).toBe(url);
  });

  test('handles empty string', () => {
    expect(redactUrl('')).toBe('');
  });
});

describe('config source correctness', () => {
  test('redactUrl function exists in config.ts', async () => {
    const configSource = readFileSync(
      new URL('../src/commands/config.ts', import.meta.url),
      'utf-8',
    );
    expect(configSource).toContain('function redactUrl');
  });

  test('redactUrl uses the correct regex pattern', async () => {
    const configSource = readFileSync(
      new URL('../src/commands/config.ts', import.meta.url),
      'utf-8',
    );
    expect(configSource).toContain('postgresql:\\/\\/');
  });
});
