/**
 * Writer administration state (BrainEngine readWriterAdminState): the same jsonb document as the SQL engines, built from the store.
 */
import type { BrainEngine } from '../../engine.ts';
import type { WriterAdminStateOptions } from '../../engine-sql/writer-admin.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, takeOptions } from './common.ts';

const STATE = 'readWriterAdminState';

export const readWriterAdminState = async function readWriterAdminState(brain: StoreBrain, opts?: WriterAdminStateOptions): Promise<string> {
  takeOptions(STATE, opts, [], ['lock']);
  return storeCall({ member: STATE }, () => brain.writerAdminStateText());
};
