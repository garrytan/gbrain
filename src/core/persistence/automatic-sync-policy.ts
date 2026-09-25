import type { BrainEngine } from '../engine.ts';
import { sourceConfigHasRemoteUrl } from '../sources-load.ts';
import { getWorktreeBinding } from './ownership.ts';
import { OperationError } from '../ops/contract.ts';

/** Automatic jobs never request a Git mutation on a canonical managed root.
 * A clone/immutable config flag is not ownership metadata or permission to pull.
 * Explicit manual intent is deliberately resolved elsewhere and still refused
 * by managed sync unless the operator uses drained maintenance.
 */
export async function automaticSyncPull(engine: BrainEngine, source: { id: string; config: unknown }): Promise<boolean> {
  if (!sourceConfigHasRemoteUrl(source.config)) return false;
  // Unlike generic activation checks, automatic admission needs positive proof
  // of unmanaged state. Missing/corrupt authority is not permission to enqueue.
  const rows = await engine.executeRaw<{ enabled: unknown }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  if (rows.length !== 1 || typeof rows[0]?.enabled !== 'boolean') {
    throw new OperationError('storage_error', 'Automatic sync requires exactly one known boolean persistence state.');
  }
  if (rows[0].enabled) return false;
  // Claimed-but-inactive sources must not acquire implicit pull permission.
  // Leave the execution-time activation/owner refusal intact.
  return await getWorktreeBinding(engine, source.id, null) === null;
}
