import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import * as db from '../src/core/db.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

const originalEnv = { ...process.env };
let tempHome: string;
type TestSql = ReturnType<typeof db.getConnection>;

function setPostgresSql(engine: PostgresEngine, sql: TestSql | null): void {
  Object.defineProperty(engine, '_sql', {
    value: sql,
    writable: true,
    configurable: true,
  });
}

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

afterEach(async () => {
  process.env = { ...originalEnv };
  await db.disconnect();
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

  test('createConnectedEngine registers the explicit postgres engine for legacy db.getConnection callers', async () => {
    const fakeSql = (() => []) as unknown as TestSql;
    const connectSpy = spyOn(PostgresEngine.prototype, 'connect').mockImplementation(async function (this: PostgresEngine) {
      setPostgresSql(this, fakeSql);
    });
    const disconnectSpy = spyOn(PostgresEngine.prototype, 'disconnect').mockImplementation(async function (this: PostgresEngine) {
      setPostgresSql(this, null);
    });

    try {
      const { createConnectedEngine } = await import('../src/core/engine-factory.ts');
      const engine = await createConnectedEngine({
        engine: 'postgres',
        database_url: 'postgresql://user:pass@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      });

      expect(engine).toBeInstanceOf(PostgresEngine);
      expect(db.getConnection()).toBe(fakeSql);
      await engine.disconnect();
    } finally {
      connectSpy.mockRestore();
      disconnectSpy.mockRestore();
    }
  });

  test('db.disconnect tears down the compatibility owner even after a later direct PostgresEngine.connect', async () => {
    let connectCount = 0;
    const sqlFor = new Map<PostgresEngine, TestSql>();
    const disconnectInstances: PostgresEngine[] = [];

    const connectSpy = spyOn(PostgresEngine.prototype, 'connect').mockImplementation(async function (this: PostgresEngine) {
      connectCount += 1;
      const fakeSql = Object.assign(async () => [], { label: `sql-${connectCount}` }) as unknown as TestSql;
      setPostgresSql(this, fakeSql);
      sqlFor.set(this, fakeSql);
    });
    const disconnectSpy = spyOn(PostgresEngine.prototype, 'disconnect').mockImplementation(async function (this: PostgresEngine) {
      disconnectInstances.push(this);
      setPostgresSql(this, null);
    });

    try {
      await db.connect({
        engine: 'postgres',
        database_url: 'postgresql://user:pass@localhost:5432/mbrain',
      });

      const compatibilityOwner = sqlFor.keys().next().value as PostgresEngine;
      const compatibilitySql = db.getConnection();

      const explicitEngine = new PostgresEngine();
      await explicitEngine.connect({
        engine: 'postgres',
        database_url: 'postgresql://user:pass@localhost:5432/mbrain',
      });

      expect(db.getConnection()).toBe(compatibilitySql);

      await db.disconnect();

      expect(disconnectInstances).toEqual([compatibilityOwner]);
      const explicitSql = sqlFor.get(explicitEngine);
      expect(explicitSql).toBeDefined();
      expect(explicitEngine.sql).toBe(explicitSql!);
      await explicitEngine.disconnect();
    } finally {
      connectSpy.mockRestore();
      disconnectSpy.mockRestore();
    }
  });

  test('non-postgres createConnectedEngine closes stale compatibility owners instead of leaving them queued for db.disconnect', async () => {
    const postgresDisconnects: PostgresEngine[] = [];
    const sqliteDisconnects: SQLiteEngine[] = [];

    const postgresConnectSpy = spyOn(PostgresEngine.prototype, 'connect').mockImplementation(async function (this: PostgresEngine) {
      const fakeSql = (() => []) as unknown as TestSql;
      setPostgresSql(this, fakeSql);
    });
    const postgresDisconnectSpy = spyOn(PostgresEngine.prototype, 'disconnect').mockImplementation(async function (this: PostgresEngine) {
      postgresDisconnects.push(this);
      setPostgresSql(this, null);
    });
    const sqliteConnectSpy = spyOn(SQLiteEngine.prototype, 'connect').mockImplementation(async function () {});
    const sqliteDisconnectSpy = spyOn(SQLiteEngine.prototype, 'disconnect').mockImplementation(async function (this: SQLiteEngine) {
      sqliteDisconnects.push(this);
    });

    try {
      const { createConnectedEngine } = await import('../src/core/engine-factory.ts');

      await createConnectedEngine({
        engine: 'postgres',
        database_url: 'postgresql://user:pass@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      });

      expect(() => db.getConnection()).not.toThrow();

      const sqliteEngine = await createConnectedEngine({
        engine: 'sqlite',
        database_path: join(tempHome, 'brain.db'),
        offline: true,
        embedding_provider: 'local',
        query_rewrite_provider: 'heuristic',
      });

      expect(sqliteEngine).toBeInstanceOf(SQLiteEngine);
      expect(() => db.getConnection()).toThrow('Global Postgres access removed');
      expect(postgresDisconnects).toHaveLength(1);

      await db.disconnect();

      expect(postgresDisconnects).toHaveLength(1);
      expect(sqliteDisconnects).toHaveLength(0);
    } finally {
      postgresConnectSpy.mockRestore();
      postgresDisconnectSpy.mockRestore();
      sqliteConnectSpy.mockRestore();
      sqliteDisconnectSpy.mockRestore();
    }
  });

  test('non-postgres createConnectedEngine drains stale owners before connecting and still attempts later owners after a disconnect failure', async () => {
    const postgresOwners: PostgresEngine[] = [];
    const postgresDisconnects: PostgresEngine[] = [];
    const sqliteConnects: SQLiteEngine[] = [];
    const sqliteDisconnects: SQLiteEngine[] = [];
    const disconnectError = new Error('first stale owner failed to close');

    const postgresConnectSpy = spyOn(PostgresEngine.prototype, 'connect').mockImplementation(async function (this: PostgresEngine) {
      const fakeSql = (() => []) as unknown as TestSql;
      setPostgresSql(this, fakeSql);
      postgresOwners.push(this);
    });
    const postgresDisconnectSpy = spyOn(PostgresEngine.prototype, 'disconnect').mockImplementation(async function (this: PostgresEngine) {
      postgresDisconnects.push(this);
      setPostgresSql(this, null);
      if (this === postgresOwners[1]) {
        throw disconnectError;
      }
    });
    const sqliteConnectSpy = spyOn(SQLiteEngine.prototype, 'connect').mockImplementation(async function (this: SQLiteEngine) {
      sqliteConnects.push(this);
    });
    const sqliteDisconnectSpy = spyOn(SQLiteEngine.prototype, 'disconnect').mockImplementation(async function (this: SQLiteEngine) {
      sqliteDisconnects.push(this);
    });

    try {
      const { createConnectedEngine } = await import('../src/core/engine-factory.ts');

      await db.connect({
        engine: 'postgres',
        database_url: 'postgresql://user:pass@localhost:5432/mbrain',
      });
      await createConnectedEngine({
        engine: 'postgres',
        database_url: 'postgresql://user:pass@localhost:5432/mbrain',
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      });

      await expect(createConnectedEngine({
        engine: 'sqlite',
        database_path: join(tempHome, 'brain.db'),
        offline: true,
        embedding_provider: 'local',
        query_rewrite_provider: 'heuristic',
      })).rejects.toThrow('first stale owner failed to close');

      expect(postgresDisconnects).toHaveLength(2);
      expect(sqliteConnects).toHaveLength(0);
      expect(sqliteDisconnects).toHaveLength(0);
      expect(() => db.getConnection()).toThrow('Global Postgres access removed');
      await db.disconnect();
      expect(postgresDisconnects).toHaveLength(2);
    } finally {
      postgresConnectSpy.mockRestore();
      postgresDisconnectSpy.mockRestore();
      sqliteConnectSpy.mockRestore();
      sqliteDisconnectSpy.mockRestore();
    }
  });

  test('createEngine throws for unknown engines', async () => {
    const { createEngine } = await import('../src/core/engine-factory.ts');
    await expect(createEngine({ engine: 'mysql' as any })).rejects.toThrow('Unknown engine');
  });
});
