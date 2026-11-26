/**
 * The effect worker statements the Rust store answers (engine-sql/persistence-effect-worker.ts): the claim stamp
 * (stampEffectClaim), the lease renewal (renewEffectClaim), the statements that settle a claim (advanceEffectRow,
 * completeEffectRow, retryEffectRow, retryBusyEffectRow, requeueEffectRow, parkEffectRow, failEffectRow) and the
 * withdrawal-mirror gate read (readMirrorGateRows), the effect guard's locks (lockEffectGuard), the re-arm probe
 * (hasRearmableTargets) and the consumer's idle probe (probeIdleWork).
 *
 * Each settle statement matches only the effect still claimed under the token, as the Postgres `WHERE id=$1 AND
 * execution_token=$2::uuid` does, and refuses the arguments the Postgres casts refuse (an id that is not a bigint, a
 * token that is not a uuid, JSON that does not parse). The store runs every statement in its own write, so the direct
 * lane needs nothing more here.
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Effect worker").
 */
import type { CoalescedGitClaim, EffectClaim, EffectClaimRef, EffectWorktreeOwner, MirrorGateRow } from '../../engine-sql/persistence-effect-worker.ts';
import type { IdleProbeRow, IdleProbeSpec } from '../../engine-sql/persistence-idle-probe.ts';
import type { StoreBrain } from '../store.ts';
import { assertStoreSerializedTransactions, storeCall, type StoreMember } from './common.ts';
import { heldRefusal, managedServed } from './managed-hold.ts';
import { readBrainMode } from './writer-release.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Settle<Extra> = StoreMember<[claim: EffectClaimRef & Extra], void>;

/** The settle spec the store reads: the id as text (the store casts it as Postgres casts `$1`). */
function settleSpec(claim: EffectClaimRef): Record<string, unknown> {
  return { ...claim, id: String(claim.id) };
}

async function settle(brain: Parameters<StoreMember<[], unknown>>[0], member: string, claim: EffectClaimRef): Promise<boolean> {
  return storeCall({ member }, () => brain.settleEffect(member, settleSpec(claim)));
}

/** The claimed row, or null when no effect has the id. */
export const stampEffectClaim: StoreMember<[claim: EffectClaim], Record<string, unknown> | null> = (brain, claim) =>
  storeCall({ member: 'stampEffectClaim' }, () => brain.stampEffectClaim({ ...claim, id: String(claim.id) }));

/** The claimed rows of up to `limit` ready single-file Git effects of one worktree (#5530), in claim order. */
/** Refuses as the executeRaw it replaced did while the managed_persistence hold is on (managed-hold.ts). */
export const claimCoalescedGitEffects = async function claimCoalescedGitEffects(this: unknown, brain: StoreBrain, input: CoalescedGitClaim): Promise<Record<string, unknown>[]> {
  if (!managedServed(this)) return heldRefusal(this);
  return storeCall({ member: 'claimCoalescedGitEffects' }, () => brain.claimCoalescedGitEffects({ ...input, deadOwners: [...input.deadOwners] }));
};

/** True while the effect runs under the token with no recovery; the direct lane is every store write. */
export const renewEffectClaim: StoreMember<[claim: EffectClaimRef, opts?: { direct?: boolean }], boolean> = (brain, claim) =>
  settle(brain, 'renewEffectClaim', claim);

export const advanceEffectRow: Settle<{ slug: string }> = async (brain, claim) => { await settle(brain, 'advanceEffectRow', claim); };
export const completeEffectRow: Settle<{ outcomeJson: string }> = async (brain, claim) => { await settle(brain, 'completeEffectRow', claim); };
export const retryEffectRow: Settle<{ reason: string; delayMs: number }> = async (brain, claim) => { await settle(brain, 'retryEffectRow', claim); };
export const retryBusyEffectRow: Settle<{ dataJson: string; delayMs: number }> = async (brain, claim) => { await settle(brain, 'retryBusyEffectRow', claim); };
export const requeueEffectRow: Settle<{ dataJson: string; reason: string | null; delayMs: number }> = async (brain, claim) => { await settle(brain, 'requeueEffectRow', claim); };
export const parkEffectRow: Settle<{ dataJson: string }> = async (brain, claim) => { await settle(brain, 'parkEffectRow', claim); };
export const failEffectRow: Settle<{ reason: string }> = async (brain, claim) => { await settle(brain, 'failEffectRow', claim); };

/** The withdrawal mirrors that gate these requests; a non-uuid request id refuses as `::uuid[]` does. */
export const readMirrorGateRows: StoreMember<[requestIds: readonly string[]], MirrorGateRow[]> = (brain, requestIds) =>
  storeCall({ member: 'readMirrorGateRows' }, () => brain.readMirrorGateRows([...requestIds]));

/**
 * The effect guard's locks: the share locks are skipped while explicit transactions hold the writer
 * (`serialized_transactions`), and the member asserts it; in multi-user mode the brain row's share lock becomes a read of
 * the brain's stored mode and the worktree row read here is in the read set. The worktree's owner and state come from its
 * binding record (`readWorktreeOwner`), null when the effect has no worktree or the row is gone. A worktree id that is not
 * a uuid refuses as `::uuid` does.
 */
export const lockEffectGuard = async function lockEffectGuard(this: unknown, brain: StoreBrain, worktreeId: string | null): Promise<EffectWorktreeOwner | null> {
  assertStoreSerializedTransactions(brain, 'lockEffectGuard');
  if (worktreeId !== null && !UUID.test(worktreeId)) throw new Error(`invalid input syntax for type uuid: "${worktreeId}"`);
  // Multi-user mode: a mode change committed before the commit refuses it and the transaction runs again. Single-user mode
  // reads nothing more, as before.
  if (brain.multiuser === true) await readBrainMode(brain, 'lockEffectGuard');
  // While the managed_persistence hold is on, no worktree effect is admitted, and the guard answers as it did before managed
  // mode was served (no owner row).
  if (worktreeId === null || !managedServed(this)) return null;
  const owner = await storeCall({ member: 'lockEffectGuard' }, () => brain.readWorktreeOwner(worktreeId)) as { owner_host_id: string | null; state: string } | null;
  return owner ? { owner_host_id: owner.owner_host_id as string, state: owner.state } : null;
};

/** Whether a target parked under `code` waits on a committed withdrawal mirror; a non-uuid request id refuses as `::uuid[]` does. */
export const hasRearmableTargets: StoreMember<[requestIds: readonly string[], code: string], boolean> = (brain, requestIds, code) =>
  storeCall({ member: 'hasRearmableTargets' }, () => brain.hasRearmableTargets([...requestIds], code));

/**
 * The consumer's idle probe (engine-sql/persistence-idle-probe.ts). The worktree, effect-recovery, topology-recovery
 * and overdue-deferred terms join the worktree row as the SQL does (gbrain-store persistence/idle_probe.rs); the lane
 * and the direct route are the store itself.
 */
export const probeIdleWork: StoreMember<[spec: IdleProbeSpec, opts?: { signal?: AbortSignal; lane?: unknown; direct?: boolean }], IdleProbeRow | null> =
  (brain, spec) => storeCall({ member: 'probeIdleWork' }, () => brain.probeIdleWork({
    hostId: spec.hostId, excludedRoots: [...spec.excludedRoots], publishing: spec.publishing, retryingTopologies: [...spec.retryingTopologies],
    laneRoots: [...spec.laneRoots], cursor: { after: { ...spec.cursor.after }, highWater: spec.cursor.highWater },
    abandonedBefore: spec.abandonedBefore, foregroundPriority: spec.foregroundPriority,
  }));
