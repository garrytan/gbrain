/**
 * The effect-journal members (BrainEngine selectClaimableEffect through hasRearmableEffects), served by gbrain-store
 * `effects`. The store keeps no worktrees, refresh fences or recovery records, so two members answer here without a
 * call: `lockPersistenceBrainShare` does nothing (one write transaction runs at a time) and `requestsStillPublishing`
 * is null (no request holds a recovery record). What each member answers and why: rust/docs/store/effects.md.
 */
import type { EffectClaimRef, EffectQueue, MirrorGateRow } from '../../engine-sql/persistence-effects.ts';
import type { PersistenceEffect } from '../../persistence/effect-model.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The timestamp columns of an effect row, Dates as PGLite returns a timestamptz. */
const EFFECT_DATES = ['updated_at', 'claim_expires_at', 'next_attempt_at'] as const;

function effectRow(row: PersistenceEffect | null): PersistenceEffect | null {
  return row ? withDates(row as unknown as Record<string, unknown>, [...EFFECT_DATES]) as unknown as PersistenceEffect : null;
}

export const selectClaimableEffect: StoreMember<[hostId: string, deadOwners: readonly string[]], PersistenceEffect | null> =
  async (brain, hostId, deadOwners) => effectRow(await storeCall({ member: 'selectClaimableEffect' },
    () => brain.selectClaimableEffect(hostId, [...deadOwners])));

export const claimEffect: StoreMember<[id: string | number, token: string, claimOwnerJson: string], PersistenceEffect | null> =
  async (brain, id, token, claimOwnerJson) => effectRow(await storeCall({ member: 'claimEffect' },
    () => brain.claimEffect(String(id), token, claimOwnerJson)));

export const queueEffects: StoreMember<[queue: EffectQueue], string[]> = async (brain, queue) =>
  queue.queued.length === 0 ? [] : storeCall({ member: 'queueEffects' }, () => brain.queueEffects({ ...queue, queued: [...queue.queued] }));

export const releaseAbandonedEffectClaims: StoreMember<[cutoff: Date], number> = (brain, cutoff) =>
  storeCall({ member: 'releaseAbandonedEffectClaims' }, () => brain.releaseAbandonedEffectClaims(cutoff.toISOString()));

/** The store runs one write transaction at a time, so nothing can change the brain row under a reader. */
export const lockPersistenceBrainShare: StoreMember<[], void> = async () => undefined;

/** The store keeps no recovery records, so no request of any worktree recovers: null, as `bool_and` over no rows. */
export const requestsStillPublishing: StoreMember<[worktreeId: string], boolean | null> = async () => null;

export const listMirrorGates: StoreMember<[requestIds: readonly string[]], MirrorGateRow[]> = async (brain, requestIds) =>
  requestIds.length === 0 ? [] : storeCall({ member: 'listMirrorGates' }, () => brain.listMirrorGates([...requestIds]));

export const completeEffect: StoreMember<[id: string | number, token: string | null, outcome: Record<string, unknown>], boolean> =
  (brain, id, token, outcome) => storeCall({ member: 'completeEffect' }, () => brain.completeEffect(String(id), token, outcome));

export const completeEffects: StoreMember<[rows: readonly EffectClaimRef[], outcome: Record<string, unknown>], number> =
  async (brain, rows, outcome) => rows.length === 0 ? 0 : storeCall({ member: 'completeEffects' },
    () => brain.completeEffects(rows.map(row => ({ id: String(row.id), token: row.token })), outcome));

export const hasRearmableEffects: StoreMember<[requestIds: readonly string[]], boolean> = async (brain, requestIds) =>
  requestIds.length === 0 ? false : storeCall({ member: 'hasRearmableEffects' }, () => brain.hasRearmableEffects([...new Set(requestIds)]));
