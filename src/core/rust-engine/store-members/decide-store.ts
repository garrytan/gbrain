/**
 * The decide store (engine-sql/decide-store.ts), served by the store (rust/docs/store/decide-store.md): decide state,
 * the spend ledger, receipts and calibrations. Timestamps cross the binding as ISO text and come back as `Date`s, as
 * PGLite returns them.
 */
import { storeCall, type StoreMember } from './common.ts';

// ---------------------------------------------------------------- state

export const readDecideState: StoreMember<[key: string], string | null> = (brain, key) =>
  storeCall({ member: 'readDecideState' }, () => brain.readDecideState(key));

export const upsertDecideState: StoreMember<[key: string, value: string], void> = async (brain, key, value) => {
  await storeCall({ member: 'upsertDecideState' }, () => brain.upsertDecideState(key, value ?? null));
};

export const deleteDecideState: StoreMember<[key: string], void> = async (brain, key) => {
  await storeCall({ member: 'deleteDecideState' }, () => brain.deleteDecideState(key));
};

export const ensureDecideState: StoreMember<[key: string, value: string], string | null> = (brain, key, value) =>
  storeCall({ member: 'ensureDecideState' }, () => brain.ensureDecideState(key, value ?? null));
