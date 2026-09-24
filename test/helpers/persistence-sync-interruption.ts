import type { BrainEngine } from '../../src/core/engine.ts';
import type { SyncOpts } from '../../src/commands/sync.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';

export async function interruptAfterSyncDiscovery(engine: BrainEngine, opts: SyncOpts) {
  const abort = new AbortController(), transaction = engine.transaction;
  let discovered = false;
  engine.transaction = async function (this: BrainEngine, run: (tx: BrainEngine) => Promise<unknown>) {
    let saved = false;
    const value = await transaction.call(this, async tx => {
      const execute = tx.executeRaw;
      tx.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
        const rows = await execute.call(this, sql, params);
        if (sql.includes('INSERT INTO op_checkpoints') && params?.[0] === 'managed-sync') saved = true;
        return rows;
      } as BrainEngine['executeRaw'];
      try { return await run(tx); }
      finally { tx.executeRaw = execute; }
    });
    if (saved) { discovered = true; abort.abort(); }
    return value;
  } as BrainEngine['transaction'];
  try {
    const result = await performManagedSync(engine, { ...opts, signal: abort.signal });
    if (!discovered) throw new Error('The sync discovery transaction did not commit');
    return result;
  } finally { engine.transaction = transaction; }
}
