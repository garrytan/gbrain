import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const originalEnv = { ...process.env };
let tempHome: string;

function writeConfig(config: Record<string, unknown>) {
  const dir = join(tempHome, '.gbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'gbrain-engine-factory-'));
  process.env.HOME = tempHome;
  delete process.env.GBRAIN_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(tempHome, { recursive: true, force: true });
});

describe('engine factory', () => {
  test('creates a Postgres engine for legacy configs with no engine key', async () => {
    writeConfig({
      database_url: 'postgresql://user:pass@localhost:5432/gbrain',
    });

    const { loadConfig } = await import('../src/core/config.ts');
    const { createEngineFromConfig } = await import('../src/core/engine-factory.ts');
    const { PostgresEngine } = await import('../src/core/postgres-engine.ts');

    const config = loadConfig();
    expect(config?.engine).toBe('postgres');

    const engine = createEngineFromConfig(config!);
    expect(engine).toBeInstanceOf(PostgresEngine);
  });

  test('selects sqlite from config and instantiates the SQLite engine', async () => {
    writeConfig({
      engine: 'sqlite',
      database_path: '~/.gbrain/brain.db',
      offline: true,
      embedding_provider: 'local',
      query_rewrite_provider: 'heuristic',
    });

    const { loadConfig } = await import('../src/core/config.ts');
    const { createEngineFromConfig } = await import('../src/core/engine-factory.ts');

    const config = loadConfig();
    expect(config?.engine).toBe('sqlite');

    const engine = createEngineFromConfig(config!);
    expect(engine).toBeInstanceOf(SQLiteEngine);
  });

  test('rejects local-only provider settings on postgres before bootstrap proceeds', async () => {
    const { resolveConfig } = await import('../src/core/engine-factory.ts');

    expect(() => resolveConfig({
      engine: 'postgres',
      database_url: 'postgresql://user:pass@localhost:5432/gbrain',
      embedding_provider: 'local',
    })).toThrow(/embedding_provider.*requires sqlite/i);
  });

  test('rejects unsupported engines before bootstrap proceeds', async () => {
    const { resolveConfig } = await import('../src/core/engine-factory.ts');

    expect(() => resolveConfig({
      engine: 'mysql' as unknown as 'postgres',
      database_url: 'postgresql://user:pass@localhost:5432/gbrain',
    })).toThrow(/unsupported engine: mysql/i);
  });
});
