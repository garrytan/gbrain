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
import type { EffectClaim } from '../../engine-sql/persistence-effect-worker.ts';
import type { IdleProbeRow, IdleProbeSpec } from '../../engine-sql/persistence-idle-probe.ts';
import { storeCall, type StoreMember } from './common.ts';

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
