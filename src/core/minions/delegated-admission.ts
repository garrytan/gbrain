import type { BrainEngine } from '../engine.ts';
import { snapshotFromJob, effectiveDelegation, DelegationDeniedError } from './delegated-policy.ts';
import { QueueQuotaExceededError } from './admission.ts';

/** Replay retains the original owner and permission/spend ceiling. To change
 * those bounds, submit fresh work with a new authenticated grant snapshot. */
export function prepareDelegatedReplay(name: string, original: Record<string, unknown>, overrides: Record<string, unknown> = {}): { data: Record<string, unknown>; clientId?: string } {
  const identityFields = ['__owner_client_id', '__delegation_grant', 'client_id'];
  if (identityFields.some(key => Object.prototype.hasOwnProperty.call(overrides, key))) {
    throw new DelegationDeniedError(['replay_identity_override_forbidden']);
  }
  const snapshot = snapshotFromJob(original);
  if (snapshot) {
    if (name !== 'subagent' || snapshot.legacy) throw new DelegationDeniedError(['replay_original_snapshot_missing']);
    const bounds = ['allowed_tools', 'allowed_slug_prefixes', 'source_id', 'sourceId', 'brain_id', 'brainId', 'max_turns', 'max_tokens'];
    if (bounds.some(key => Object.prototype.hasOwnProperty.call(overrides, key))) throw new DelegationDeniedError(['replay_bound_override_forbidden']);
  }
  return { data: { ...original, ...overrides }, ...(snapshot ? { clientId: snapshot.clientId } : {}) };
}

/** Terminal -> waiting consumes a client slot just like a fresh submission. */
export async function admitDelegatedRetry(tx: BrainEngine, id: number): Promise<boolean> {
  const prior = await tx.getFailedJobForRetry(id);
  if (!prior) return false;
  const { clientId } = prepareDelegatedReplay(prior.name, prior.data);
  if (!clientId) return true;
  const limit = await lockDelegatedSubmission(tx, clientId, prior.name, prior.data, id);
  // Another retry may have won while this transaction waited for the client.
  if (!await tx.getFailedJobForRetry(id)) return false;
  await checkDelegatedCapacity(tx, clientId, limit);
  return true;
}

/** Caller holds this transaction through any coalescing and the final INSERT. */
export async function lockDelegatedSubmission(tx: BrainEngine, clientId: string | undefined, name: string, data?: Record<string, unknown>, jobId?: number): Promise<number | null> {
  if (!clientId) return null;
  if (name !== 'subagent' || data?.__owner_client_id !== clientId) throw new Error('invalid delegated submission owner');
  await tx.lockOAuthClient(clientId);
  const submitted = snapshotFromJob(data);
  if (!submitted) throw new DelegationDeniedError(['snapshot_missing']);
  return (await effectiveDelegation(tx, submitted, jobId)).maxConcurrent;
}

/** Across every queue and nonterminal state; coalesced existing work adds no slot. */
export async function checkDelegatedCapacity(tx: BrainEngine, clientId: string | undefined, limit: number | null): Promise<void> {
  if (limit === null) return;
  // An unowned admission has no rows to count (the old `data->>'__owner_client_id' = NULL` matched none).
  const n = clientId ? await tx.countOpenJobsByOwner(clientId) : 0;
  if (n >= limit) throw new QueueQuotaExceededError('subagent', n, limit);
}
