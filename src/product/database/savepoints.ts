import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../core/engine.ts';

export function withPgliteSavepoints(engine: BrainEngine): BrainEngine {
  if (engine.kind !== 'pglite') return engine;
  const db = (engine as unknown as { db: { query: (sql: string, params?: unknown[]) => Promise<unknown> } }).db;
  const wrapped = Object.create(engine) as BrainEngine;
  const prefix = `pmbrain_${randomUUID().replaceAll('-', '')}`;
  let sequence = 0;
  const nested = async <T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> => {
    const name = `${prefix}_${++sequence}`;
    await db.query(`SAVEPOINT ${name}`);
    try {
      const value = await fn(wrapped);
      await db.query(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (error) {
      await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await db.query(`RELEASE SAVEPOINT ${name}`);
      throw error;
    }
  };
  const scopedDb = new Proxy(db, { get(target, property) {
    if (property === 'transaction') return <T>(fn: (db: typeof scopedDb) => Promise<T>) => nested(() => fn(scopedDb));
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  Object.defineProperty(wrapped, 'db', { value: scopedDb });
  wrapped.transaction = nested;
  return wrapped;
}
