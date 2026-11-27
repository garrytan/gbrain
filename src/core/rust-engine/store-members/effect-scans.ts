/**
 * The effect scans the Rust store answers (engine-sql/persistence-effect-scans.ts): the reads the effect worker's pass
 * runs before it claims effects (listGatedMirrorRequests, listEffectRecoveries) and the claim's candidate read
 * (selectClaimableEffect), a write receipt's read of its effects (readRequestEffects), and the embedding effects
 * `gbrain repair embedding-effects` settles (listEmbeddingCandidates).
 *
 * The worktree scans join persistence effects to the worktrees a host owns (persistence/worktree_rows.rs). No effect
 * recovery is written on this engine yet, so `listEffectRecoveries` answers no row; it still refuses the arguments the
 * Postgres casts refuse (a host id that is not a uuid, an `after` that is not a bigint, a fractional or negative limit).
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Effect scans").
 */
import type { EmbeddingCandidate, GatedMirrorRequest, RequestEffectState } from '../../engine-sql/persistence-effect-scans.ts';
import { requestRow, withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The requests whose withdrawal mirror is parked under `gateCode` on a worktree the host owns, when every unsettled effect is parked only with `allowedCodes`. */

/** No effect carries a recovery here, so none is recovered; the cursor and limit are still checked as Postgres casts them. */
export const listEffectRecoveries: StoreMember<[hostId: string, after: string | null, limit: number], Record<string, unknown>[]> =
  (brain, hostId, after, limit) => storeCall({ member: 'listEffectRecoveries' }, () => brain.listEffectRecoveries(hostId, after, limit));

/** The requests whose withdrawal mirror is parked under `gateCode` on a worktree the host owns, when every unsettled effect is parked only with `allowedCodes`. */
export const listGatedMirrorRequests: StoreMember<[hostId: string, gateCode: string, allowedCodes: readonly string[]], GatedMirrorRequest[]> =
  (brain, hostId, gateCode, allowedCodes) => storeCall({ member: 'listGatedMirrorRequests' }, () => brain.listGatedMirrorRequests(hostId, gateCode, [...allowedCodes]));

/**
 * The next effect to claim with the Postgres queue rules (effect_worker.rs): queued, an expired claim or a claim of a dead
 * owner, due now, with no recovery and no withdrawal mirror of its request pending; on no worktree, or on an active one
 * the host owns with no fence refresh and no recovery.
 */
export const selectClaimableEffect: StoreMember<[hostId: string, deadOwners: readonly string[]], Record<string, unknown> | null> =
  (brain, hostId, deadOwners) => storeCall({ member: 'selectClaimableEffect' }, () => brain.selectClaimableEffect(hostId, [...deadOwners]));

/** The request's stored effects, in kind order, or only its Git effect; a non-uuid request id refuses as `::uuid` does. */
export const readRequestEffects: StoreMember<[requestId: string, kind?: 'git'], RequestEffectState[]> =
  (brain, requestId, kind) => storeCall({ member: 'readRequestEffects' }, () => brain.readRequestEffects(requestId, kind ?? null));
