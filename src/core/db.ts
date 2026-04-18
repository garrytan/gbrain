import postgres from 'postgres';
import { MBrainError, type EngineConfig } from './types.ts';
import { SCHEMA_SQL } from './schema-embedded.ts';

type ConnectedPostgresEngine = {
  sql: ReturnType<typeof postgres>;
  disconnect(): Promise<void>;
};

let connectionOwner: ConnectedPostgresEngine | null = null;

export function registerConnectionOwner(engine: ConnectedPostgresEngine): void {
  connectionOwner = engine;
}

export function clearConnectionOwner(engine?: ConnectedPostgresEngine): void {
  if (!engine || connectionOwner === engine) {
    connectionOwner = null;
  }
}

export function unsupportedGlobalConnectionAccess(): never {
  throw new MBrainError(
    'Global Postgres access removed',
    'Use a connected PostgresEngine instance instead.',
    'Create the engine through createConnectedEngine().',
  );
}

export function getConnection(): ReturnType<typeof postgres> {
  if (!connectionOwner) {
    unsupportedGlobalConnectionAccess();
  }
  return connectionOwner.sql;
}

export async function connect(config: EngineConfig): Promise<void> {
  if (connectionOwner) return;

  const { PostgresEngine } = await import('./postgres-engine.ts');
  const engine = new PostgresEngine();
  try {
    await engine.connect(config);
  } catch (e) {
    clearConnectionOwner(engine);
    throw e;
  }
}

export async function disconnect(): Promise<void> {
  const engine = connectionOwner;
  connectionOwner = null;
  if (engine) {
    await engine.disconnect();
  }
}

export async function initSchema(): Promise<void> {
  const conn = getConnection();
  // Advisory lock prevents concurrent initSchema() calls from deadlocking
  await conn`SELECT pg_advisory_lock(42)`;
  try {
    await conn.unsafe(SCHEMA_SQL);
  } finally {
    await conn`SELECT pg_advisory_unlock(42)`;
  }
}

export async function withTransaction<T>(fn: (tx: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const conn = getConnection();
  return conn.begin(async (tx) => {
    return fn(tx as unknown as ReturnType<typeof postgres>);
  });
}
