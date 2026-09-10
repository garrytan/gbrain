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
  const rows = await tx.executeRaw<{ name: string; data: Record<string, unknown> }>(
    "SELECT name,data FROM minion_jobs WHERE id=$1 AND status IN ('failed','dead')", [id]);
  if (!rows.length) return false;
  const { clientId } = prepareDelegatedReplay(rows[0].name, rows[0].data);
  if (!clientId) return true;
  const limit = await lockDelegatedSubmission(tx, clientId, rows[0].name, rows[0].data);
  // Another retry may have won while this transaction waited for the client.
  const current = await tx.executeRaw("SELECT id FROM minion_jobs WHERE id=$1 AND status IN ('failed','dead')", [id]);
  if (!current.length) return false;
  await checkDelegatedCapacity(tx, clientId, limit);
  return true;
}

/** Caller holds this transaction through any coalescing and the final INSERT. */
export async function lockDelegatedSubmission(tx: BrainEngine, clientId: string | undefined, name: string, data?: Record<string, unknown>): Promise<number | null> {
  if (!clientId) return null;
  if (name !== 'subagent' || data?.__owner_client_id !== clientId) throw new Error('invalid delegated submission owner');
  await tx.executeRaw('SELECT client_id FROM oauth_clients WHERE client_id = $1 FOR UPDATE', [clientId]);
  const submitted = snapshotFromJob(data);
  if (!submitted) throw new DelegationDeniedError(['snapshot_missing']);
  return (await effectiveDelegation(tx, submitted)).maxConcurrent;
}

/** Across every queue and nonterminal state; coalesced existing work adds no slot. */
export async function checkDelegatedCapacity(tx: BrainEngine, clientId: string | undefined, limit: number | null): Promise<void> {
  if (limit === null) return;
  const counts = await tx.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM minion_jobs
     WHERE name = 'subagent' AND status IN ('waiting','active','delayed','waiting-children','paused')
       AND data->>'__owner_client_id' = $1`, [clientId],
  );
  if (Number(counts[0]?.n ?? 0) >= limit) throw new QueueQuotaExceededError('subagent', Number(counts[0]?.n ?? 0), limit);
}
