/**
 * The persistence brain identity (BrainEngine readPersistenceBrainId), served from the id the store mints when it creates a brain.
 */
import { storeErrorCode } from '../store-errors.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readPersistenceBrainId: StoreMember<[], string | null> = async (brain) => {
  try {
    const identity: { brain_id?: unknown } = await storeCall({ member: 'readPersistenceBrainId' }, () => brain.getBrainIdentity());
    return typeof identity.brain_id === 'string' && identity.brain_id !== '' ? identity.brain_id : null;
  } catch (error) {
    if (storeErrorCode(error) === 'writer_not_initialized') return null;
    throw error;
  }
};
