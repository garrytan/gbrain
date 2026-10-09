/**
 * #6278: why a source's canonical owner is unavailable to this process, one
 * reason per condition. `maintenancePreflight` (chronicle, fact-fence
 * adoption, every maintenance submitter), `gbrain repair fences` and the
 * managed file repair admission all refuse with the code `owner_unavailable`
 * (the sync drain branches on that code), and this matrix gives each reason
 * its message, `why`, actor, next step and read-only verify, so the same
 * condition reads the same everywhere.
 *
 * Reasons, in the order they are checked:
 *   binding_missing            the source has no canonical worktree binding
 *   incarnation_changed        the binding belongs to an earlier incarnation of the source
 *   host_mismatch              another host id owns the checkout (a host-id split on one
 *                              machine looks exactly like this; both ids are printed)
 *   transfer_in_progress       the worktree is `draining` (a writer transfer is prepared)
 *   clone_in_progress          the worktree is `recovering` (a topology clone or reclone)
 *   local_path_missing         this host has no registered checkout path for the worktree
 *   coordination_path_missing  this host's registration has no coordination directory
 *
 * The two in-progress reasons are a `wait` (the fix's actor is `provider`;
 * the `why` names the delay); the rest are a host administrator's decision
 * (`tell_user_to_run`). `host_mismatch` is `retryable: false`: retrying on
 * the same host cannot change the answer. Nothing here claims or transfers
 * ownership; the fix is always the read-only writer status, and the local
 * identity file path is printed to local callers only (it carries a home
 * directory). The owner's own identity path is never known here, so it is
 * never printed.
 */
import { join } from 'node:path';
import type { Action } from '../agent-output.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { persistenceHome } from './identity.ts';
import type { WorktreeBinding } from './ownership.ts';

export const OWNER_UNAVAILABLE_REASONS = ['host_mismatch', 'transfer_in_progress', 'clone_in_progress', 'binding_missing', 'incarnation_changed',
  'coordination_path_missing', 'local_path_missing'] as const;
export type OwnerUnavailableReason = typeof OWNER_UNAVAILABLE_REASONS[number];

/** Seconds a caller waits before retrying while a transfer or clone is in progress. */
export const OWNER_WAIT_SECONDS = 30;

/** A binding this host may publish through: active, owned here, with both registered paths. */
export type ActiveOwnerBinding = WorktreeBinding & { state: 'active'; local_path: string; coordination_path: string };

/** The first condition that makes the binding unusable by host `hostId` for source incarnation `incarnation`, or the usable binding. */
export function checkOwner(binding: WorktreeBinding | null, incarnation: string, hostId: string): { reason: OwnerUnavailableReason } | { reason: null; binding: ActiveOwnerBinding } {
  if (!binding) return { reason: 'binding_missing' };
  if (String(binding.source_incarnation) !== String(incarnation)) return { reason: 'incarnation_changed' };
  if (binding.owner_host_id !== hostId) return { reason: 'host_mismatch' };
  if (binding.state === 'draining') return { reason: 'transfer_in_progress' };
  if (binding.state === 'recovering') return { reason: 'clone_in_progress' };
  if (!binding.local_path) return { reason: 'local_path_missing' };
  if (!binding.coordination_path) return { reason: 'coordination_path_missing' };
  return { reason: null, binding: binding as ActiveOwnerBinding };
}

/** The reason alone; null when the binding is usable. */
export function ownerUnavailableReason(binding: WorktreeBinding | null, incarnation: string, hostId: string): OwnerUnavailableReason | null {
  return checkOwner(binding, incarnation, hostId).reason;
}

export interface OwnerRefusalInput {
  sourceId: string;
  reason: OwnerUnavailableReason;
  binding: WorktreeBinding | null;
  /** The source's current incarnation. */
  incarnation: string;
  /** This process's host id (`localHostId()`). */
  hostId: string;
  /** `OperationContext.remote`: a remote caller never sees a local path. */
  remote: boolean;
  /** What was refused, in the message: "maintenance", "fence repair", "the file repair". */
  work: string;
}

export interface OwnerRefusal {
  reason: OwnerUnavailableReason;
  message: string;
  why: string;
  fix: Action;
  retryable: boolean;
}

const short = (id: string | null | undefined) => (id ?? 'unknown').slice(0, 8);

function writerStatus(sourceId: string): string[] {
  return ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'];
}

/** The matrix row for one refusal: message, why, fix (with its read-only verify) and whether a retry can help. */
export function ownerRefusal(input: OwnerRefusalInput): OwnerRefusal {
  const { sourceId, reason, binding, work } = input;
  const status = writerStatus(sourceId);
  const verify = { argv: status };
  const admin = (why: string, user: string): Action => ({ argv: status, consent: [], actor: 'host_admin', requires_exclusive: false, why, user_message: user, verify });
  const wait = (why: string): Action => ({ argv: status, consent: [], actor: 'provider', requires_exclusive: false,
    why: `${why} Wait ${OWNER_WAIT_SECONDS} seconds, run this status read, and retry the same request once the worktree state is active.`, verify });
  const never = `Nothing was written and no model work ran; ${work} never claims or transfers ownership to run.`;
  switch (reason) {
    case 'binding_missing':
      return { reason, retryable: false, message: `Source ${sourceId} has no canonical owner, so ${work} did not run.`,
        why: `No worktree binding records a canonical checkout for source ${sourceId}. ${never}`,
        fix: admin('Shows whether the source has a canonical binding and which host owns it; claiming one is the host administrator\'s decision.',
          `gbrain could not run ${work} for source ${sourceId}: no host owns its checkout. Review writer status on the brain host and decide whether to claim it.`) };
    case 'incarnation_changed':
      return { reason, retryable: false, message: `Source ${sourceId}'s canonical binding belongs to an earlier incarnation of the source, so ${work} did not run.`,
        why: `The binding records incarnation ${short(binding?.source_incarnation)} but the source is now incarnation ${short(input.incarnation)} (it was removed and re-added, or restored), so the checkout it names is not this source's. ${never}`,
        fix: admin('Shows the binding\'s incarnation beside the source\'s; re-binding the checkout is the host administrator\'s decision.',
          `gbrain could not run ${work} for source ${sourceId}: its checkout binding is from before the source was re-created. Review writer status on the brain host.`) };
    case 'host_mismatch': {
      const local = input.remote ? '' : ` (this process read its identity from ${join(persistenceHome(), 'host.json')})`;
      return { reason, retryable: false, message: `Source ${sourceId} is owned by host ${short(binding?.owner_host_id)}, not this host (${short(input.hostId)}), so ${work} did not run.`,
        why: `The canonical checkout of source ${sourceId} belongs to host id ${short(binding?.owner_host_id)}; this process runs as host id ${short(input.hostId)}${local}. `
          + `If both run on one machine, the two environments read different GBRAIN_HOME identity files (a launchd or cron worker with another GBRAIN_HOME or user than the shell), and retrying from this one cannot change the answer. ${never}`,
        fix: admin(`Shows the owner host of source ${sourceId}; run ${work} there, or align GBRAIN_HOME so the worker and the shell share one host identity. Do not copy or regenerate host.json: a new identity orphans the ownership recorded for the old one.`,
          `gbrain could not run ${work} for source ${sourceId} because a different host identity owns its checkout. Run it on the owner host (writer status names it), or make both environments use the same GBRAIN_HOME.`) };
    }
    case 'transfer_in_progress':
      return { reason, retryable: true, message: `Source ${sourceId}'s worktree is draining for a writer transfer, so ${work} waits.`,
        why: `A writer transfer of source ${sourceId} is prepared and its worktree is in state draining; until the transfer is accepted or cancelled no host may publish to it. ${never}`,
        fix: wait(`Source ${sourceId}'s worktree is draining for a writer transfer (gbrain sources writer transfer prepare was run); the status read shows its state.`) };
    case 'clone_in_progress':
      return { reason, retryable: true, message: `Source ${sourceId}'s worktree is being cloned or recloned, so ${work} waits.`,
        why: `A topology clone of source ${sourceId}'s checkout is in progress and its worktree is in state recovering; it becomes active when the clone finishes. ${never}`,
        fix: wait(`Source ${sourceId}'s worktree is recovering while a topology clone runs; the status read shows when it is active again.`) };
    case 'local_path_missing':
      return { reason, retryable: false, message: `This host has no registered checkout path for source ${sourceId}, so ${work} did not run.`,
        why: `Host ${short(input.hostId)} owns source ${sourceId}'s worktree but has no local path registered for it (the host binding row is missing or empty). ${never}`,
        fix: admin('Shows the host bindings of the worktree; registering the checkout path again is the host administrator\'s decision.',
          `gbrain could not run ${work} for source ${sourceId}: this host owns the checkout but has no path registered for it. Review writer status on the brain host.`) };
    case 'coordination_path_missing':
      return { reason, retryable: false, message: `This host's registration for source ${sourceId} has no coordination directory, so ${work} did not run.`,
        why: `Host ${short(input.hostId)} owns source ${sourceId}'s worktree and has a checkout path, but no coordination path (the directory the physical-root stamp and locks live in); the registration predates it or was edited. ${never}`,
        fix: admin('Shows the host binding with its coordination path; repairing the registration is the host administrator\'s decision.',
          `gbrain could not run ${work} for source ${sourceId}: this host's checkout registration is incomplete. Review writer status on the brain host.`) };
  }
}

/** The `owner_unavailable` error for one refusal (message, why, reason, fix and the site's retryable). */
export function ownerUnavailableError(input: OwnerRefusalInput): OperationError {
  const row = ownerRefusal(input);
  return opError('owner_unavailable', row.message, `${row.why} Read writer status with the command in fix${row.retryable ? ', wait, and retry' : ' and act on what it shows'}.`,
    { reason: row.reason, why: row.why, fix: row.fix, retryable: row.retryable });
}
