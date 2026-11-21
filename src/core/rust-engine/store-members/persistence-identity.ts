/**
 * The persistence brain identity (BrainEngine readPersistenceBrainId), served from the id the store mints when it
 * creates a brain (`brain.getBrainIdentity()`, rust/docs/store/journal.md). PGLite reads the same value from its
 * `persistence_brain` row: a lowercase hyphenated UUID, or null when the row is missing. A store without an id
 * rejects `writer_not_initialized`; the member answers null for it, as PGLite does for a missing row. A `lock` read
 * answers the same id: the store's writes are exclusive, so there is no row lock to take.
 */
import { storeErrorCode } from '../store-errors.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readPersistenceBrainId: StoreMember<[opts?: { lock?: boolean }], string | null> = async (brain) => {
  try {
    const identity: { brain_id?: unknown } = await storeCall({ member: 'readPersistenceBrainId' }, () => brain.getBrainIdentity());
    return typeof identity.brain_id === 'string' && identity.brain_id !== '' ? identity.brain_id : null;
  } catch (error) {
    if (storeErrorCode(error) === 'writer_not_initialized') return null;
    throw error;
  }
};
