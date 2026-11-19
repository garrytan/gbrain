/**
 * The effect scans the Rust store answers (engine-sql/persistence-effect-scans.ts): the reads the effect worker's pass
 * runs before it claims effects (listGatedMirrorRequests, listEffectRecoveries) and the claim's candidate read
 * (selectClaimableEffect), and a write receipt's read of its effects (readRequestEffects).
 *
 * Each scan joins persistence effects to the worktrees a host owns. The store keeps no worktree and claims no effect yet,
 * so each one answers no row; it still refuses the arguments the Postgres casts refuse (a host id that is not a uuid,
 * an `after` that is not a bigint, a fractional or negative limit).
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Effect scans").
 */
import type { GatedMirrorRequest, RequestEffectState } from '../../engine-sql/persistence-effect-scans.ts';
import { storeCall, type StoreMember } from './common.ts';

/** No request has a parked withdrawal mirror here, so none is requeued; the codes change nothing. */
export const listGatedMirrorRequests: StoreMember<[hostId: string, gateCode: string, allowedCodes: readonly string[]], GatedMirrorRequest[]> =
  (brain, hostId) => storeCall({ member: 'listGatedMirrorRequests' }, () => brain.listGatedMirrorRequests(hostId));

/** No effect carries a recovery here, so none is recovered; the cursor and limit are still checked as Postgres casts them. */
export const listEffectRecoveries: StoreMember<[hostId: string, after: string | null, limit: number], Record<string, unknown>[]> =
  (brain, hostId, after, limit) => storeCall({ member: 'listEffectRecoveries' }, () => brain.listEffectRecoveries(hostId, after, limit));

/** No effect is claimed on this engine yet, so a stored effect waits queued (null); the dead owner keys change nothing. */
export const selectClaimableEffect: StoreMember<[hostId: string, deadOwners: readonly string[]], Record<string, unknown> | null> =
  (brain, hostId) => storeCall({ member: 'selectClaimableEffect' }, () => brain.selectClaimableEffect(hostId));

/** The request's stored effects, in kind order, or only its Git effect; a non-uuid request id refuses as `::uuid` does. */
export const readRequestEffects: StoreMember<[requestId: string, kind?: 'git'], RequestEffectState[]> =
  (brain, requestId, kind) => storeCall({ member: 'readRequestEffects' }, () => brain.readRequestEffects(requestId, kind ?? null));
