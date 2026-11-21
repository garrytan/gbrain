import type { BrainEngine } from '../../src/core/engine.ts';

/**
 * Wraps the engine's transactions so the first statement matching `pattern` throws `error()` (a run-scoped failure injected
 * mid-transaction, so the transaction rolls back); every other statement runs on the real transaction. Returns the restore.
 */
export function failTransactionAt(engine: BrainEngine, pattern: RegExp, error: () => unknown): () => void {
  const original = engine.transaction;
  (engine as unknown as { transaction: BrainEngine['transaction'] }).transaction = ((fn: (tx: BrainEngine) => Promise<unknown>) => original.call(engine, (tx: BrainEngine) => fn(new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'executeRaw') return async (sql: string, params?: unknown[]) => { if (pattern.test(sql)) throw error(); return target.executeRaw(sql, params); };
      const value = Reflect.get(target, prop, target);
      // The writer-admin store runs its SQL on the engine it is asked on, so ask it on the wrapper: its statements then
      // pass the pattern too. Every other method stays bound to the real transaction.
      if (prop === 'writerAdminStore' && typeof value === 'function') return value.bind(receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  })))) as BrainEngine['transaction'];
  return () => { delete (engine as unknown as { transaction?: unknown }).transaction; };
}
