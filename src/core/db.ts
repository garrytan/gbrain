import postgres from 'postgres';
import { MBrainError, type EngineConfig } from './types.ts';
import { SCHEMA_SQL } from './schema-embedded.ts';

type ConnectedPostgresEngine = {
  sql: ReturnType<typeof postgres>;
  disconnect(): Promise<void>;
};

const connectionOwners: ConnectedPostgresEngine[] = [];
let activeConnectionOwner: ConnectedPostgresEngine | null = null;

export function registerConnectionOwner(engine: ConnectedPostgresEngine): void {
  if (!connectionOwners.includes(engine)) {
    connectionOwners.push(engine);
  }
  activeConnectionOwner = engine;
}

export function clearConnectionOwner(engine?: ConnectedPostgresEngine): void {
  if (!engine) {
    activeConnectionOwner = null;
    return;
  }

  const index = connectionOwners.indexOf(engine);
  if (index !== -1) {
    connectionOwners.splice(index, 1);
  }

  if (activeConnectionOwner === engine) {
    activeConnectionOwner = connectionOwners.at(-1) ?? null;
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
  if (!activeConnectionOwner) {
    unsupportedGlobalConnectionAccess();
  }
  return activeConnectionOwner.sql;
}

export async function connect(config: EngineConfig): Promise<void> {
  if (activeConnectionOwner) return;

  const { PostgresEngine } = await import('./postgres-engine.ts');
  const engine = new PostgresEngine();
  try {
    await engine.connect(config);
    registerConnectionOwner(engine);
  } catch (e) {
    clearConnectionOwner(engine);
    throw e;
  }
}

export async function disconnect(): Promise<void> {
  const owners = [...connectionOwners];
  connectionOwners.length = 0;
  activeConnectionOwner = null;

  for (const engine of owners.reverse()) {
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
