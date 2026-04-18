import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const originalEnv = { ...process.env };
let tempHome: string;

function writeConfig(config: Record<string, unknown>) {
  const dir = join(tempHome, '.mbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'mbrain-engine-factory-'));
  process.env.HOME = tempHome;
  delete process.env.MBRAIN_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(tempHome, { recursive: true, force: true });
});

describe('engine factory', () => {
  test('capability helpers delegate to the shared engine capability policy', async () => {
    const { getEngineCapabilities } = await import('../src/core/engine-capabilities.ts');
    const {
      supportsParallelWorkers,
      supportsRawPostgresAccess,
    } = await import('../src/core/engine-factory.ts');

    for (const engine of ['postgres', 'sqlite', 'pglite'] as const) {
      const config = { engine } as const;
      const capabilities = getEngineCapabilities(config as any);

      expect(supportsParallelWorkers(config as any)).toBe(capabilities.parallelWorkers);
      expect(supportsRawPostgresAccess(config as any)).toBe(capabilities.rawPostgresAccess);
    }
  });

  test('creates a Postgres engine for legacy configs with no engine key', async () => {
    writeConfig({
      database_url: 'postgresql://user:pass@localhost:5432/mbrain',
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
      database_path: '~/.mbrain/brain.db',
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
      database_url: 'postgresql://user:pass@localhost:5432/mbrain',
      embedding_provider: 'local',
    })).toThrow(/embedding_provider.*requires sqlite/i);
  });

  test('rejects unsupported engines before bootstrap proceeds', async () => {
    const { resolveConfig } = await import('../src/core/engine-factory.ts');

    expect(() => resolveConfig({
      engine: 'mysql' as unknown as 'postgres',
      database_url: 'postgresql://user:pass@localhost:5432/mbrain',
    })).toThrow(/unsupported engine: mysql/i);
  });

  test('createEngine returns PGLiteEngine for pglite', async () => {
    const { createEngine } = await import('../src/core/engine-factory.ts');
    const engine = await createEngine({ engine: 'pglite' });
    expect(engine.constructor.name).toBe('PGLiteEngine');
  });

  test('createEngine returns SQLiteEngine for sqlite', async () => {
    const { createEngine } = await import('../src/core/engine-factory.ts');
    const engine = await createEngine({ engine: 'sqlite', database_path: join(tempHome, 'brain.db') });
    expect(engine).toBeInstanceOf(SQLiteEngine);
  });

  test('createEngine returns PostgresEngine for postgres and by default', async () => {
    const { createEngine } = await import('../src/core/engine-factory.ts');
    const postgresEngine = await createEngine({ engine: 'postgres' });
    const defaultEngine = await createEngine({});
    expect(postgresEngine.constructor.name).toBe('PostgresEngine');
    expect(defaultEngine.constructor.name).toBe('PostgresEngine');
  });

  test('createEngine throws for unknown engines', async () => {
    const { createEngine } = await import('../src/core/engine-factory.ts');
    await expect(createEngine({ engine: 'mysql' as any })).rejects.toThrow('Unknown engine');
  });
});
