/**
 * The write journal's upkeep statements (BrainEngine persistenceUpkeepStore; SQL in engine-sql/persistence-upkeep.ts),
 * served from the store's request, effect and counter records: each statement is one
 * `persistenceUpkeep(op, args)` call (gbrain-store `persistence/upkeep.rs`), answering what the SQL it replaces answers.
 *
 * - `limitCompactionWaits` changes nothing: the lock and statement waits are Postgres settings, and the store runs one
 *   write transaction at a time, so no compaction waits behind another write.
 * - The locked receipt comes back as the SQL engines return `r.*`: its timestamps as Dates.
 *
 * What each statement answers and why: rust/docs/store/persistence.md ("Upkeep").
 */
import type { PersistenceUpkeepStore } from '../../engine-sql/persistence-upkeep.ts';
import { requestRow } from '../store-codec.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall } from './common.ts';

const MEMBER = 'persistenceUpkeepStore';

export const persistenceUpkeepStore = async (brain: StoreBrain): Promise<PersistenceUpkeepStore> => {
  const call = <T>(op: string, ...args: unknown[]) => storeCall({ member: MEMBER }, () => brain.persistenceUpkeep(op, args)) as Promise<T>;
  return {
    limitCompactionWaits: async () => {},
    lockCompactionReceipt: async (id, completedBefore) => requestRow(await call('lockCompactionReceipt', id, completedBefore)) as never,
    hasUnfinishedEffect: (requestId) => call<boolean>('hasUnfinishedEffect', requestId),
    newestSyncReceiptId: (worktreeId) => call<string | null>('newestSyncReceiptId', worktreeId),
    requestEffectBytes: (requestId) => call<string>('requestEffectBytes', requestId),
    markReceiptCompacted: async (id, retained) => { await call('markReceiptCompacted', id, retained); },
    releaseTerminalBytes: async (keys, freed) => { await call('releaseTerminalBytes', [...keys], freed); },
    lockRearmableEffects: (requestIds, code) => call('lockRearmableEffects', [...requestIds], code),
    rearmEffect: async (id, dataJson) => { await call('rearmEffect', id, dataJson); },
    renewHeldEffectClaim: (id, token) => call<boolean>('renewHeldEffectClaim', id, token),
    floorPreparationAttempts: async (id, limit) => { await call('floorPreparationAttempts', id, limit); },
    chargePreparationAttempt: async (id, token) => {
      const charged = await call<number | string | null>('chargePreparationAttempt', id, token);
      return charged === null ? null : Number(charged);
    },
    readHealthFacts: (roots) => call('readHealthFacts', [...roots]),
    nextScanSlug: (sourceId, afterSlug) => call<string | null>('nextScanSlug', sourceId, afterSlug),
    effectRecovering: (id) => call<boolean | null>('effectRecovering', id),
    recordSkippedTarget: async (id, token, targetJson, limit) => { await call('recordSkippedTarget', id, token, targetJson, limit); },
    listOwnedBoundSources: (hostId) => call<string[]>('listOwnedBoundSources', hostId),
  };
};
