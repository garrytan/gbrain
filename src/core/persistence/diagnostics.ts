import type { BrainEngine } from '../engine.ts';
import { journalLimitKey, readJournalLimits } from './limits.ts';
import type { JournalLimits } from './model.ts';
import { publicationConcurrency } from './pool-capacity.ts';

export const WRITER_NEXT_ACTIONS: Record<string, string> = {
  unexpected_staging_bytes: 'Keep the worktree blocked and retain its staging files and recovery capacity. Compare the recorded staging size and hash, then reconcile unexpected bytes explicitly before retrying; never discard unverified staging files.',
  unexpected_file_bytes: 'Keep the worktree blocked. Compare current bytes with the recorded before/after fingerprints and resolve the local edit explicitly; never overwrite unexpected bytes.',
  commit_outcome_uncertain: 'Recover on the designated owner and inspect the durable receipt before retrying publication.',
  publication_failed: 'Allow conditional file restoration to finish; inspect the retained terminal failure before submitting a corrected write.',
  database_contention: 'Keep the same request_id; the owner will retry after the SQL lock or connection contention clears.',
  revision_changed_repreparing: 'Keep the same request_id while the owner recomputes this supported semantic mutation against the latest revision.',
  writer_pool_capacity: 'Configure the ordinary Postgres pool with at least two connections, then restart the resident writer.',
  owner_unavailable: 'Start the designated owner. Transfer ownership only after draining recovery and verifying the successor checkout; fence an unreachable owner externally first.',
  writer_busy: 'Keep the same request_id and wait for the current worktree publication to finish.',
  writer_lock_unavailable: 'Verify the bundled native addon and coordination directory permissions on the owner; never delete a live coordination lock.',
  recovery_required: 'Inspect the recorded publication fingerprints on the designated owner and settle recovery before publishing this worktree.',
  recovery_capacity: 'Allow recovery to settle or increase the applicable persistence.limits recovery byte cap. Do not remove recovery records.',
  queue_capacity: 'Let outstanding requests finish or increase the applicable persistence.limits cap. Accepted request IDs are never evicted.',
  consumer_stopping: 'Restart the resident owner and inspect the same request_id before resubmitting.',
  source_changed: 'Inspect the source incarnation and worktree binding; queued requests cannot follow a recreated source.',
  permission_denied: 'Inspect the durable principal and current source, operation, and namespace grants.',
};
export function writerNextAction(reason: string | null | undefined): string {
  return reason && WRITER_NEXT_ACTIONS[reason] || 'Inspect the sanitized receipt and owner diagnostics before retrying with the same request_id.';
}
interface Counter { key: string; outstanding_count: string | number; intent_bytes: string | number;
  lifetime_ids: string | number; terminal_bytes: string | number; recovery_bytes: string | number; }
export function capacityDiagnostics(counters: Counter[], limits: JournalLimits) {
  return counters.flatMap(counter => {
    const scope = counter.key === 'brain' ? 'brain' : counter.key.startsWith('worktree:') ? 'worktree' : 'principal';
    const resources: Array<readonly [keyof Counter, keyof JournalLimits]> = scope === 'worktree'
      ? [['recovery_bytes', 'worktreeRecoveryBytes']]
      : [['outstanding_count', `${scope}Outstanding`], ['intent_bytes', `${scope}IntentBytes`],
        ['lifetime_ids', `${scope}LifetimeIds`], ['terminal_bytes', `${scope}TerminalBytes`],
        ...(scope === 'brain' ? [['recovery_bytes', 'brainRecoveryBytes'] as const] : [])];
    return resources.map(([resource, setting]) => {
      const used = Number(counter[resource]), limit = limits[setting];
      const approaching = limit === 0 ? used > 0 : used >= limit * 0.8;
      return { scope: counter.key, resource, used, limit, remaining: Math.max(0, limit - used),
        approaching_capacity: approaching, config_key: journalLimitKey(setting),
        ...(approaching ? { next_action: `Review capacity and raise ${journalLimitKey(setting)} if needed. Permanent accepted IDs and reserved completion space must not be deleted.` } : {}) };
    });
  });
}
/** Trusted-admin counts only: neither normalized intent nor private paths leave here. */
export async function readWriterDiagnostics(engine: BrainEngine) {
  const [brain] = await engine.executeRaw<{ enabled: boolean; brain_id: string }>('SELECT enabled,brain_id FROM persistence_brain WHERE singleton=1');
  const worktrees = await engine.executeRaw(`SELECT w.id,w.owner_host_id,w.owner_epoch::text AS owner_epoch,w.topology_generation::text AS topology_generation,w.state,w.heartbeat_at,
    COUNT(r.id) FILTER (WHERE r.state='queued')::integer AS queued,
    COUNT(r.id) FILTER (WHERE r.state='running')::integer AS running,
    COUNT(r.id) FILTER (WHERE r.state='recovering')::integer AS recovering,
    MIN(r.created_at) FILTER (WHERE r.state IN ('queued','running','recovering')) AS oldest_request_at,
    (MAX(r.sequence) FILTER (WHERE r.state='committed'))::text AS last_completed_sequence,
    COALESCE((SELECT c.recovery_bytes FROM persistence_counters c WHERE c.key='worktree:'||w.id::text),0)::text AS recovery_bytes,
    (SELECT COUNT(*)::integer FROM persistence_effects e WHERE e.worktree_id=w.id AND e.recovery IS NOT NULL) AS recovering_effects
    FROM persistence_worktrees w LEFT JOIN persistence_requests r ON r.worktree_id=w.id
    GROUP BY w.id ORDER BY w.id`);
  const counters = await engine.executeRaw<Counter>(`SELECT key,outstanding_count::text,intent_bytes::text,lifetime_ids::text,terminal_bytes::text,recovery_bytes::text FROM persistence_counters ORDER BY key`);
  const blockers = await engine.executeRaw<{ request_id: string; worktree_id: string | null; state: string; blocked_reason: string | null; error_code: string | null }>(
    `SELECT request_id,worktree_id,state,blocked_reason,error_code,created_at
    FROM persistence_requests WHERE state='recovering' OR blocked_reason IS NOT NULL ORDER BY sequence LIMIT 100`);
  const queue = await engine.executeRaw(`SELECT state,COUNT(*)::integer AS count,COALESCE(SUM(intent_bytes),0)::text AS intent_bytes,
    MIN(created_at) AS oldest_request_at,
    MAX(EXTRACT(EPOCH FROM (now()-created_at))*1000)::bigint::text AS oldest_age_ms
    FROM persistence_requests WHERE state IN ('queued','running','recovering') GROUP BY state ORDER BY state`);
  const effects = await engine.executeRaw(`SELECT e.kind,e.state,COUNT(*)::integer AS count,MIN(r.created_at) AS oldest_at
    FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
    WHERE e.state<>'committed' GROUP BY e.kind,e.state ORDER BY e.kind,e.state`);
  const limits = await readJournalLimits(engine);
  const { persistenceConsumerStatus } = await import('./service.ts');
  const ingress = persistenceConsumerStatus(engine);
  return { ...brain, sampled_at: new Date().toISOString(), publication_concurrency: publicationConcurrency(engine),
    ingress, worktrees, counters, queue, effects, limits, capacity: capacityDiagnostics(counters, limits),
    blockers: blockers.map(row => ({ ...row, next_action: writerNextAction(row.blocked_reason ?? row.error_code) })) };
}
