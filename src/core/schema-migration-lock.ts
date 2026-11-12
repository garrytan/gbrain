/**
 * GBRA-467: the one lock every path that runs schema migrations takes: initSchema() on each process start, and
 * `gbrain apply-migrations` (and --force-schema) through runMigrations(), which re-reads the schema version once the
 * lock is held, so a runner that waited finds nothing left to do. Postgres holds it across processes and connections
 * (`BrainEngine.holdSchemaMigrationLock`, key 42 in postgres-engine/init-schema-lock.ts). An engine without that
 * method (PGLite, whose datastore lock admits a single process) is serialized in this process.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from './engine.ts';

const schemaLockScope = new AsyncLocalStorage<{ engine: BrainEngine; assertHeld: () => Promise<void>; released: boolean }>();
const inProcessSchemaLocks = new WeakMap<BrainEngine, Promise<void>>();

/** Run `fn` holding the schema migration lock; a nested call on the same engine inside `fn` reuses it. */
export async function withSchemaMigrationLock<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<T> {
  const held = schemaLockScope.getStore();
  if (held?.engine === engine && !held.released) return fn();
  const run = async (assertHeld: () => Promise<void>): Promise<T> => {
    const scope = { engine, assertHeld, released: false };
    try { return await schemaLockScope.run(scope, fn); } finally { scope.released = true; }
  };
  if (engine.holdSchemaMigrationLock) return engine.holdSchemaMigrationLock(run);
  const previous = inProcessSchemaLocks.get(engine) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(resolve => { release = resolve; });
  inProcessSchemaLocks.set(engine, previous.then(() => mine));
  await previous;
  try {
    return await run(async () => {});
  } finally {
    release();
  }
}

/** Throws when the lock the current scope took has been lost; the runner calls it before each migration. */
export async function assertSchemaMigrationLockHeld(): Promise<void> {
  await schemaLockScope.getStore()?.assertHeld();
}
