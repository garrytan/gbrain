/**
 * Read-replica routing scope. A Postgres brain configured with
 * `replica_database_url` (or GBRAIN_REPLICA_DATABASE_URL) serves the engine's
 * read seams from the replica, but only while a non-mutating read operation is
 * running inside `withOperationReadRouting`. Everything else, including every
 * read a write operation makes, stays on the primary.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Operation } from './ops/contract.ts';

/** How long after a write in this process reads stay on the primary, so the replica's lag cannot hide that write. */
export const REPLICA_READ_YOUR_WRITES_MS = 5_000;

const replicaScope = new AsyncLocalStorage<boolean>();
let lastWriteAt = Number.NEGATIVE_INFINITY;

/** The cli-socket's read test (src/core/cli-socket/execute.ts): read scope and not mutating. */
export function isReplicaEligible(op: Pick<Operation, 'scope' | 'mutating'>): boolean {
  return op.scope === 'read' && !op.mutating;
}

/** True when the current async context may read from the replica. */
export function replicaReadsAllowed(): boolean {
  return replicaScope.getStore() === true;
}

/** Runs one operation: an eligible read may use the replica; a mutating op pins this process's reads to the primary for a while. */
export async function withOperationReadRouting<T>(op: Pick<Operation, 'scope' | 'mutating'>, run: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  if (isReplicaEligible(op)) return replicaScope.run(now() - lastWriteAt >= REPLICA_READ_YOUR_WRITES_MS, run);
  // An op dispatched from inside a read op must not inherit the read's replica scope.
  try { return await replicaScope.run(false, run); }
  finally { if (op.mutating) lastWriteAt = now(); }
}

/** Test hook: forget the last write so the next read is eligible again. */
export function _resetReplicaReadsForTests(): void {
  lastWriteAt = Number.NEGATIVE_INFINITY;
}
