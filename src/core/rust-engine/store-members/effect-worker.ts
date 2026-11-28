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
 * lane changes nothing here.
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Effect worker").
 */
import type { EffectClaim, EffectClaimRef, EffectWorktreeOwner, MirrorGateRow } from '../../engine-sql/persistence-effect-worker.ts';
import type { IdleProbeRow, IdleProbeSpec } from '../../engine-sql/persistence-idle-probe.ts';
import { storeCall, type StoreMember } from './common.ts';
import type { StoreBrain } from '../store.ts';

type Settle<Extra> = StoreMember<[claim: EffectClaimRef & Extra], void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The settle spec the store reads: the id as text (the store casts it as Postgres casts `$1`). */
function settleSpec(claim: EffectClaimRef): Record<string, unknown> {
  return { ...claim, id: String(claim.id) };
}

async function settle(brain: Parameters<StoreMember<[], unknown>>[0], member: string, claim: EffectClaimRef): Promise<boolean> {
  return storeCall({ member }, () => brain.settleEffect(member, settleSpec(claim)));
}

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

/** The claimed row, or null when no effect has the id. */
export const stampEffectClaim: StoreMember<[claim: EffectClaim], Record<string, unknown> | null> = (brain, claim) =>
  storeCall({ member: 'stampEffectClaim' }, () => brain.stampEffectClaim({ ...claim, id: String(claim.id) }));

/**
 * The effect guard's locks: the store runs one write at a time, so the share locks have nothing to wait for (an
 * explicit transaction is Serialized and holds the store's writer; under optimistic transactions the worktree row read
 * here is in the read set). The worktree's owner and state come from its binding record (`readWorktreeOwner`), null when
 * the effect has no worktree or the row is gone. A worktree id that is not a uuid refuses as `::uuid` does.
 */
export const lockEffectGuard: StoreMember<[worktreeId: string | null], EffectWorktreeOwner | null> = async (brain: StoreBrain, worktreeId) => {
  if (worktreeId !== null && !UUID.test(worktreeId)) throw new Error(`invalid input syntax for type uuid: "${worktreeId}"`);
  if (!worktreeId) return null;
  const owner: { owner_host_id: string; state: string } | null = await storeCall({ member: 'lockEffectGuard' }, () => brain.readWorktreeOwner(worktreeId));
  return owner ? { owner_host_id: owner.owner_host_id, state: owner.state } : null;
};

export const retryEffectRow: Settle<{ reason: string; delayMs: number }> = async (brain, claim) => { await settle(brain, 'retryEffectRow', claim); };

/** Whether a target parked under `code` waits on a committed withdrawal mirror; a non-uuid request id refuses as `::uuid[]` does. */
export const hasRearmableTargets: StoreMember<[requestIds: readonly string[], code: string], boolean> = (brain, requestIds, code) =>
  storeCall({ member: 'hasRearmableTargets' }, () => brain.hasRearmableTargets([...requestIds], code));

/** The withdrawal mirrors that gate these requests; a non-uuid request id refuses as `::uuid[]` does. */
export const readMirrorGateRows: StoreMember<[requestIds: readonly string[]], MirrorGateRow[]> = (brain, requestIds) =>
  storeCall({ member: 'readMirrorGateRows' }, () => brain.readMirrorGateRows([...requestIds]));

export const advanceEffectRow: Settle<{ slug: string }> = async (brain, claim) => { await settle(brain, 'advanceEffectRow', claim); };

export const retryBusyEffectRow: Settle<{ dataJson: string; delayMs: number }> = async (brain, claim) => { await settle(brain, 'retryBusyEffectRow', claim); };

export const requeueEffectRow: Settle<{ dataJson: string; reason: string | null; delayMs: number }> = async (brain, claim) => { await settle(brain, 'requeueEffectRow', claim); };

export const parkEffectRow: Settle<{ dataJson: string }> = async (brain, claim) => { await settle(brain, 'parkEffectRow', claim); };

export const completeEffectRow: Settle<{ outcomeJson: string }> = async (brain, claim) => { await settle(brain, 'completeEffectRow', claim); };

/** True while the effect runs under the token with no recovery; the direct lane is every store write. */
export const renewEffectClaim: StoreMember<[claim: EffectClaimRef, opts?: { direct?: boolean }], boolean> = (brain, claim) =>
  settle(brain, 'renewEffectClaim', claim);

export const failEffectRow: Settle<{ reason: string }> = async (brain, claim) => { await settle(brain, 'failEffectRow', claim); };
