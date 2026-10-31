import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { PoolCapacityError } from '../pool-budget.ts';
import { tryAcquirePublicationCapacity } from './pool-capacity.ts';

interface TopologyTransactionScope { root: BrainEngine; tx: BrainEngine; active: boolean; }
const scopes = new AsyncLocalStorage<TopologyTransactionScope>();
const STATEMENT_CAP = '5s';
async function scoped<T>(root: BrainEngine, tx: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
  const scope = { root, tx, active: true };
  try { return await scopes.run(scope, () => run(tx)); }
  finally { scope.active = false; }
}

/**
 * #7702: run one bulk statement whose cost grows with the data it deletes, not
 * with contention, without the statement cap; the 1 s lock_timeout stays and
 * the cap is restored for the statements after it. Call it inside a topology
 * transaction only.
 */
export async function withoutStatementCap<T>(tx: BrainEngine, run: () => Promise<T>): Promise<T> {
  await tx.executeRaw("SELECT set_config('statement_timeout','0',true)");
  const result = await run();
  await tx.executeRaw(`SELECT set_config('statement_timeout','${STATEMENT_CAP}',true)`);
  return result;
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
      await tx.executeRaw(`SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','${STATEMENT_CAP}',true)`);
      return scoped(engine, tx, run);
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '55P03') {
      throw new OperationError('write_pending', 'The source transaction exceeded its bounded database wait.', 'Retry the same lifecycle request_id after the current writer finishes.');
    }
    if (code === '57014') {
      throw opError('write_interrupted', 'The database ended a statement of the source transaction (SQLSTATE 57014, a statement timeout or cancel), so it rolled back and nothing changed.',
        'This is load or a database limit, not another writer, so retrying at once ends the same way. Check the brain with gbrain doctor --json, and run the same command again once the database is less loaded; if it ends this way again, report it with that output.',
        { retryable: false });
    }
    throw error;
  } finally { release(); }
}
