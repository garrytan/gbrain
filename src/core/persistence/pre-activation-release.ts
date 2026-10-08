/**
 * #6122: a source claimed on a brain whose managed persistence was never
 * activated. The claim (a source binding plus its worktree and host binding)
 * fences classic sync (`sync-authority.ts` refuses `writer_coordinator_required`)
 * but nothing publishes through it, so `gbrain sources writer deactivate` on
 * such a brain releases it: once nothing is queued, running or recovering
 * (the same blockers as a managed deactivation), one transaction marks the
 * claimed worktrees `retired` (rows kept, as deactivation does), deletes the
 * source and host bindings and records a committed `writer_deactivate`
 * topology change (`outcome.pre_activation: true`) naming the worktrees and
 * roots, so the retired-marker cleanup removes this host's claim markers.
 * The brain stays classic and its `mode_epoch` does not move. The topology change
 * needs the administering CLI registration, which a never-activated brain may lack;
 * it is created (idempotently, as activation would) for the trusted local caller.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { acquireWorktree, getWorktreeBinding } from './ownership.ts';
import { currentVerifiedLocalWriter, existingLocalHostId, registerLocalWriter } from './identity.ts';
import type { NativeLockHandle } from './native-lock.ts';
import { assertWriterAdminState } from './admin-intent.ts';
import { assertWriterAdminUnlocked } from './admin-lock.ts';
import { managedFilesystemDatastorePath, refreshManagedFilesystemRoots } from './filesystem-guard.ts';
import { recordTopologyChange } from './topology-receipts.ts';
import { lockTopologyPrincipal, topologyPrincipal } from './topology-locks.ts';
import type { SqlEngine } from './model.ts';

export interface PreActivationClaim { source_id: string; worktree_id: string; roots: string[] }

/** Every source binding of the brain with its worktree's roots. Read-only. */
export async function preActivationClaims(engine: SqlEngine): Promise<PreActivationClaim[]> {
  const rows = await engine.executeRaw<{ source_id: string; worktree_id: string; root: string | null }>(`SELECT b.source_id, b.worktree_id::text AS worktree_id, h.local_path AS root
    FROM persistence_source_bindings b LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id ORDER BY b.source_id, h.local_path`);
  const claims = new Map<string, PreActivationClaim>();
  for (const row of rows) {
    const claim = claims.get(row.source_id) ?? { source_id: row.source_id, worktree_id: row.worktree_id, roots: [] };
    if (row.root && !claim.roots.includes(row.root)) claim.roots.push(row.root);
    claims.set(row.source_id, claim);
  }
  return [...claims.values()];
}

/**
 * Releases every pre-activation claim; the caller has checked that the brain is
 * disabled and that nothing blocks. `blockers` re-runs inside the transaction.
 */
export async function releasePreActivationClaims(engine: BrainEngine, opts: { expectedState?: string; requestId?: string;
  blocked: (tx: BrainEngine) => Promise<OperationError | null> }): Promise<PreActivationClaim[]> {
  // A never-activated brain may have no CLI writer registration yet (activation creates it); the trusted local
  // operator running deactivate gets the same one, so the topology change has its administering principal.
  if (!currentVerifiedLocalWriter()) await registerLocalWriter(engine, 'cli');
  const principal = await topologyPrincipal(engine);
  const requestId = opts.requestId ?? randomUUID();
  const hostId = existingLocalHostId();
  const locks: NativeLockHandle[] = [];
  try {
    // Native worktree locks precede the transaction, as in activation and deactivation.
    const locked = new Set<string>();
    for (const claim of await preActivationClaims(engine)) {
      const binding = await getWorktreeBinding(engine, claim.source_id, hostId);
      if (!binding || binding.owner_host_id !== hostId || !binding.local_path || locked.has(binding.worktree_id)) continue;
      locked.add(binding.worktree_id);
      const lock = await acquireWorktree(binding, 0, undefined, undefined, { yieldLanes: true });
      if (!lock) throw new OperationError('writer_lock_unavailable', `A local process holds the worktree lock of claimed source '${claim.source_id}'.`,
        'Stop the gbrain process on this host that holds it (gbrain serve or autopilot), then rerun deactivate.');
      locks.push(lock);
    }
    return await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('lock_timeout','5000ms',true),set_config('synchronous_commit','on',true)");
      const [brain] = await tx.executeRaw<{ brain_id: string; enabled: boolean; mode_epoch: string }>('SELECT brain_id, enabled, mode_epoch::text FROM persistence_brain WHERE singleton=1 FOR UPDATE');
      await assertWriterAdminState(tx, opts.expectedState);
      await assertWriterAdminUnlocked(tx);
      if (!brain || brain.enabled) throw opError('writer_admin_state_changed', 'Managed persistence was activated concurrently; no claim was released.',
        'Another process activated managed persistence while this release ran, so the claims now belong to the managed writer. Review the brain-wide deactivation preview before deciding anything else.',
        { fix: readFix('Previews the brain-wide deactivation and its blockers; changes nothing.', { argv: ['gbrain', 'sources', 'writer', 'deactivate', '--dry-run', '--json'] }) });
      await tx.executeRaw('SELECT id FROM persistence_worktrees ORDER BY id FOR UPDATE');
      await tx.executeRaw('SELECT id FROM sources ORDER BY id FOR UPDATE');
      const refused = await opts.blocked(tx);
      if (refused) throw refused;
      const claims = await preActivationClaims(tx);
      if (!claims.length) return [];
      const worktrees = [...new Set(claims.map(claim => claim.worktree_id))];
      await tx.executeRaw("UPDATE persistence_worktrees SET state='retired' WHERE id=ANY($1::uuid[]) AND state<>'retired'", [worktrees]);
      await tx.executeRaw('DELETE FROM persistence_source_bindings');
      await tx.executeRaw('DELETE FROM persistence_host_bindings WHERE worktree_id=ANY($1::uuid[])', [worktrees]);
      const retired = worktrees.map(id => ({ id, roots: [...new Set(claims.filter(claim => claim.worktree_id === id).flatMap(claim => claim.roots))] }));
      await lockTopologyPrincipal(tx, principal);
      await recordTopologyChange(tx, { principal, requestId, intent: { operation: 'writer_deactivate' }, operation: 'writer_deactivate', sourceId: '*',
        incarnation: null, worktrees }, { brain_id: brain.brain_id, pre_activation: true, mode_epoch: Number(brain.mode_epoch), worktrees: retired,
        source_roots: retired.flatMap(worktree => worktree.roots), sources: claims.map(claim => claim.source_id) });
      await refreshManagedFilesystemRoots(tx, managedFilesystemDatastorePath(engine));
      return claims;
    });
  } finally { for (const lock of locks.reverse()) await lock.release(); }
}
