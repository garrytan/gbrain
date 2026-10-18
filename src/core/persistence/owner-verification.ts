/**
 * #6741 C: the claim's owner verification, shared by writer onboarding (its `recovery_required` state, which the
 * managed purge reads per source) and the background admission check. A claimed source whose owner is this host
 * can publish only when its host binding names a canonical path and a coordination lock path and the physical root
 * still carries its marker and reservation (`assertPhysicalRoot`). A worktree whose state is still `active` can
 * fail it, for example after `.gbrain-owner.json` is deleted, so a state-only check misses it.
 *
 * A declared background producer (an explicit background origin or a withAdmissionOrigin('background') run; see
 * declaredBackground) verifies each source once per run (backgroundOwnerCheck caches the outcome for the surrounding
 * background scope; an explicit origin outside a scope verifies per admission) and, when it fails, is refused
 * `owner_unavailable` with the owner-status fix before any receipt, so no request id is spent. An admission on the
 * implicit default keeps the publication's own physical-root fences and their specific codes.
 */
import type { Action } from '../agent-output.ts';
import { OperationError } from '../ops/contract.ts';
import type { SqlEngine } from './model.ts';
import { existingLocalHostId } from './identity.ts';
import { getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { assertPhysicalRoot } from './physical-root.ts';
import { backgroundOwnerCheck, backgroundOwnerUnverified } from './admission-origin.ts';

/**
 * The owner verification for a binding owned by this host: null when it holds, else why not (with the physical-root
 * error, if any). `restampable`: the paths are recorded and the only change is the filesystem device id (#5604), which
 * the owner's locked worktree acquisition re-stamps before it publishes.
 */
export function verifyOwnerRoot(binding: Pick<WorktreeBinding, 'worktree_id' | 'local_path' | 'coordination_path'>): { physical_error?: string; restampable?: true } | null {
  let failed = !binding.local_path || !binding.coordination_path;
  let physicalError: string | undefined, restampable = false;
  if (binding.local_path) {
    try { assertPhysicalRoot(binding.local_path, { worktreeId: binding.worktree_id, coordinationPath: binding.coordination_path }); }
    catch (error) {
      restampable = !failed && error instanceof OperationError && error.detail === 'physical_root_device_changed';
      failed = true; physicalError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!failed) return null;
  return { ...(physicalError ? { physical_error: physicalError } : {}), ...(restampable ? { restampable: true as const } : {}) };
}

/** Refuses a background admission for a source whose owner on this host fails the verification (cached per background run). */
export async function assertBackgroundOwner(engine: SqlEngine, sourceId: string, ownerStatusFix: (sourceId: string) => Action): Promise<void> {
  const refusal = await backgroundOwnerCheck(sourceId, async () => {
    const host = existingLocalHostId();
    const binding = await getWorktreeBinding(engine, sourceId, host);
    if (!binding || binding.owner_host_id !== host) return null;
    const failure = verifyOwnerRoot(binding);
    // A device-only change is re-stamped by the publication's own locked acquisition (#5604), so it does not refuse here.
    return failure && !failure.restampable ? backgroundOwnerUnverified(sourceId, failure.physical_error, ownerStatusFix(sourceId)) : null;
  });
  if (refusal) throw refusal;
}
