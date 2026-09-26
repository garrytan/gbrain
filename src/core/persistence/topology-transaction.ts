import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { PoolCapacityError } from '../pool-budget.ts';
import { tryAcquirePublicationCapacity } from './pool-capacity.ts';

interface TopologyTransactionScope { root: BrainEngine; tx: BrainEngine; active: boolean; }
const scopes = new AsyncLocalStorage<TopologyTransactionScope>();
async function scoped<T>(root: BrainEngine, tx: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
  const scope = { root, tx, active: true };
  try { return await scopes.run(scope, () => run(tx)); }
  finally { scope.active = false; }
}

/**
 * Bound the publication/recovery phase before checking out an ordinary
 * connection. Provider work and clone preparation must run outside this scope.
 * Nested helpers reuse this transaction's permit and its reserved control slot.
 */
export async function topologyTransaction<T>(engine: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
  const current = scopes.getStore();
  if (current?.active && (engine === current.root || engine === current.tx)) return current.tx.transaction(tx => scoped(current.root, tx, run));
  const release = tryAcquirePublicationCapacity(engine);
  if (!release) throw new PoolCapacityError();
  try {
    return await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
      return scoped(engine, tx, run);
    });
  } catch (error) {
    if (['55P03','57014'].includes((error as { code?: string }).code ?? '')) {
      throw new OperationError('write_pending', 'The source transaction exceeded its bounded database wait.', 'Retry the same lifecycle request_id after the current writer finishes.');
    }
    throw error;
  } finally { release(); }
}
