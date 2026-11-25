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
export const listGatedMirrorRequests: StoreMember<[hostId: string, gateCode: string, allowedCodes: readonly string[]], GatedMirrorRequest[]> =
  (brain, hostId, gateCode, allowedCodes) => storeCall({ member: 'listGatedMirrorRequests' }, () => brain.listGatedMirrorRequests(hostId, gateCode, [...allowedCodes]));

/** No effect carries a recovery here, so none is recovered; the cursor and limit are still checked as Postgres casts them. */
export const listEffectRecoveries: StoreMember<[hostId: string, after: string | null, limit: number], Record<string, unknown>[]> =
  (brain, hostId, after, limit) => storeCall({ member: 'listEffectRecoveries' }, () => brain.listEffectRecoveries(hostId, after, limit));

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

/** The stale queued and failed embedding effects of committed writes, with the characters a retry would embed. */
export const listEmbeddingCandidates: StoreMember<[sourceIds: readonly string[], neverRetried: readonly string[]], EmbeddingCandidate[]> =
  (brain, sourceIds, neverRetried) => storeCall({ member: 'listEmbeddingCandidates' },
    () => brain.listEmbeddingCandidates([...sourceIds], [...neverRetried]));

/** The timestamp columns of an effect row, as the SQL engines return them (Dates). */
const EFFECT_DATES = ['updated_at', 'claim_expires_at', 'next_attempt_at'];
const effectRow = <R>(row: unknown): R | null => row === null || row === undefined ? null : withDates(row as object, EFFECT_DATES) as R;

/** Request row `id` of the source (`SELECT *`), or null; a non-uuid id refuses (persistence/effect_retry_reads.rs). */
export const readSourceRequestById: StoreMember<[sourceId: string, id: string], Record<string, unknown> | null> = async (brain, sourceId, id) =>
  requestRow(await storeCall({ member: 'readSourceRequestById', sourceId }, () => brain.readSourceRequestById(sourceId, id)));

/** At most two request rows of the source admitted under the client request id, by sequence. */
export const listSourceRequestsByRequestId: StoreMember<[sourceId: string, requestId: string], Array<Record<string, unknown>>> = async (brain, sourceId, requestId) =>
  ((await storeCall({ member: 'listSourceRequestsByRequestId', sourceId }, () => brain.listSourceRequestsByRequestId(sourceId, requestId))) as unknown[])
    .map(row => requestRow<Record<string, unknown>>(row)!);

/** The effects of a request row that a parked-effect retry tracks, by kind in byte order. */
export const listRetryTrackedEffects: StoreMember<[requestRowId: string, parkedOnly: boolean, failedCodes: readonly string[]], Array<Record<string, unknown>>> =
  async (brain, requestRowId, parkedOnly, failedCodes) =>
    ((await storeCall({ member: 'listRetryTrackedEffects' }, () => brain.listRetryTrackedEffects(requestRowId, parkedOnly, [...failedCodes]))) as unknown[])
      .map(row => effectRow<Record<string, unknown>>(row)!);

/** Effect `id` (`SELECT *`), or null; the store write is exclusive, so the row lock takes nothing. */
export const lockEffectRow: StoreMember<[id: string | number], Record<string, unknown> | null> = async (brain, id) =>
  effectRow(await storeCall({ member: 'lockEffectRow' }, () => brain.lockEffectRow(String(id))));
