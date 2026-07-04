import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const originalEnv = { ...process.env };
let tempHome: string;

function writeUserConfig(config: Record<string, unknown>) {
  const dir = join(tempHome, '.mbrain');
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
  tempHome = mkdtempSync(join(tmpdir(), 'mbrain-config-'));
  process.env.HOME = tempHome;
  delete process.env.MBRAIN_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(tempHome, { recursive: true, force: true });
});

describe('config loading', () => {
  test('createLocalConfigDefaults uses qwen3-embedding:0.6b as the local default embedding model', async () => {
    const { createLocalConfigDefaults } = await import('../src/core/config.ts');
    expect(createLocalConfigDefaults().embedding_model).toBe('qwen3-embedding:0.6b');
  });

  test('loads sqlite engine settings from config', async () => {
    writeUserConfig({
      engine: 'sqlite',
      database_path: '~/.mbrain/brain.db',
      offline: true,
      embedding_provider: 'local',
      embedding_model: 'bge-m3',
      query_rewrite_provider: 'heuristic',
    });

    const { loadConfig } = await import('../src/core/config.ts');
    const config = loadConfig();

    expect(config).toMatchObject({
      engine: 'sqlite',
      database_path: '~/.mbrain/brain.db',
      offline: true,
      embedding_provider: 'local',
      embedding_model: 'bge-m3',
      query_rewrite_provider: 'heuristic',
    });
  });

  test('preserves backward compatibility for legacy config files with no engine key', async () => {
    writeUserConfig({
      database_url: 'postgresql://user:pass@localhost:5432/mbrain',
    });

    const { loadConfig } = await import('../src/core/config.ts');
    expect(loadConfig()).toMatchObject({
      engine: 'postgres',
      database_url: 'postgresql://user:pass@localhost:5432/mbrain',
      offline: false,
    });
  });

  test('defaults env-only database config to postgres unless local mode is explicitly configured', async () => {
    process.env.MBRAIN_DATABASE_URL = 'postgresql://env-user:env-pass@localhost:5432/mbrain';

    const { loadConfig } = await import('../src/core/config.ts');
    expect(loadConfig()).toMatchObject({
      engine: 'postgres',
      database_url: 'postgresql://env-user:env-pass@localhost:5432/mbrain',
      offline: false,
    });
  });

  test('keeps explicit sqlite mode even when postgres env vars are present', async () => {
    writeUserConfig({
      engine: 'sqlite',
      database_path: '~/.mbrain/brain.db',
      offline: true,
      embedding_provider: 'local',
      query_rewrite_provider: 'heuristic',
    });
    process.env.MBRAIN_DATABASE_URL = 'postgresql://env-user:env-pass@localhost:5432/mbrain';

    const { loadConfig } = await import('../src/core/config.ts');
    expect(loadConfig()).toMatchObject({
      engine: 'sqlite',
      database_path: '~/.mbrain/brain.db',
      offline: true,
      embedding_provider: 'local',
      query_rewrite_provider: 'heuristic',
    });
  });

  test('loads governed probe hybrid flag from the documented nested retrieval config', async () => {
    writeUserConfig({
      engine: 'sqlite',
      database_path: '~/.mbrain/brain.db',
      retrieval: {
        governed_probe_hybrid: true,
      },
    });

    const { loadConfig } = await import('../src/core/config.ts');
    expect(loadConfig()?.retrieval_governed_probe_hybrid).toBe(true);
  });

  test('defaults governed probe hybrid on after retrieval eval non-regression gate', async () => {
    writeUserConfig({
      engine: 'sqlite',
      database_path: '~/.mbrain/brain.db',
    });

    const { loadConfig } = await import('../src/core/config.ts');
    expect(loadConfig()?.retrieval_governed_probe_hybrid).toBe(true);
  });

  test('allows governed probe hybrid to be explicitly disabled', async () => {
    writeUserConfig({
      engine: 'sqlite',
      database_path: '~/.mbrain/brain.db',
      retrieval: {
        governed_probe_hybrid: false,
      },
    });

    const { loadConfig } = await import('../src/core/config.ts');
    expect(loadConfig()?.retrieval_governed_probe_hybrid).toBe(false);
  });

  test('loads contextual chunk embedding flag from the documented nested retrieval config', async () => {
    writeUserConfig({
      engine: 'sqlite',
      database_path: '~/.mbrain/brain.db',
      retrieval: {
        contextual_chunk_embeddings: true,
      },
    });

    const { loadConfig } = await import('../src/core/config.ts');
    expect(loadConfig()?.retrieval_contextual_chunk_embeddings).toBe(true);
  });

  test('loads usage-aware ranking flag from the documented nested retrieval config', async () => {
    writeUserConfig({
      engine: 'sqlite',
      database_path: '~/.mbrain/brain.db',
      retrieval: {
        usage_aware_ranking: true,
      },
    });

    const { loadConfig } = await import('../src/core/config.ts');
    expect(loadConfig()?.retrieval_usage_aware_ranking).toBe(true);
  });

  test('loads retrieval eval answer grounding flag from the documented nested retrieval_eval config', async () => {
    writeUserConfig({
      engine: 'sqlite',
      database_path: '~/.mbrain/brain.db',
      retrieval_eval: {
        answer_grounding: true,
      },
    });

    const { loadConfig } = await import('../src/core/config.ts');
    expect(loadConfig()?.retrieval_eval_answer_grounding).toBe(true);
  });

  test('loads governed recompile flag from the documented nested maintenance config', async () => {
    writeUserConfig({
      engine: 'sqlite',
      database_path: '~/.mbrain/brain.db',
      maintenance: {
        governed_recompile_enabled: true,
      },
    });

    const { loadConfig } = await import('../src/core/config.ts');
    expect(loadConfig()?.maintenance_governed_recompile_enabled).toBe(true);
  });

  test('loads Dream phase timeout from the documented nested maintenance config', async () => {
    writeUserConfig({
      engine: 'sqlite',
      database_path: '~/.mbrain/brain.db',
      maintenance: {
        phase_timeout_ms: 12_345,
      },
    });

    const { loadConfig } = await import('../src/core/config.ts');
    expect(loadConfig()?.maintenance_phase_timeout_ms).toBe(12_345);
  });

  test('loads source rank rules from nested retrieval config', async () => {
    writeUserConfig({
      engine: 'sqlite',
      database_path: '~/.mbrain/brain.db',
      retrieval: {
        source_rank_rules: [
          { prefix: 'office/personal/', factor: 1.45 },
          { prefix: 'office/', factor: 1.05 },
        ],
      },
    });

    const { loadConfig } = await import('../src/core/config.ts');
    expect(loadConfig()?.retrieval_source_rank_rules).toEqual([
      { prefix: 'office/personal/', factor: 1.45 },
      { prefix: 'office/', factor: 1.05 },
    ]);
  });
});

describe('redactUrl', () => {
  test('redacts password in postgres:// URL through command helper', async () => {
    const { redactUrl: redactCommandUrl } = await import('../src/commands/config.ts');
    const url = 'postgres://user:secretpass@host:5432/dbname';
    expect(redactCommandUrl(url)).toBe('postgres://user:***@host:5432/dbname');
  });

  test('redacts secret-like postgres URL query parameters through command helper', async () => {
    const { redactUrl: redactCommandUrl } = await import('../src/commands/config.ts');
    const url = 'postgresql://user:secretpass@host:5432/dbname?password=querypass&sslpassword=sslpass&application_name=mbrain';
    const redacted = redactCommandUrl(url);
    expect(redacted).toBe('postgresql://user:***@host:5432/dbname?password=***&sslpassword=***&application_name=mbrain');
    expect(redacted).not.toContain('password=querypass');
    expect(redacted).not.toContain('sslpassword=sslpass');
    expect(redacted).not.toContain(':secretpass@');
  });

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
    expect(configSource).toContain('postgres(?:ql)?');
  });
});
