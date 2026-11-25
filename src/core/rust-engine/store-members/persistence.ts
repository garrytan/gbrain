/**
 * The persistence state reads the import path makes (BrainEngine readManagedModeRows, ownsSchemaTables): the one brain row's stored mode, and
 * the store owning its own tables.
 */
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The stored brain mode: `enabled` and `mode_epoch` (text) of the persistence brain row. */
async function readBrainMode(brain: StoreBrain, member: string): Promise<{ enabled: boolean; mode_epoch: string }> {
  return storeCall({ member }, () => brain.writerReleaseRows({ kind: 'brain_mode' }));
}

/** The one singleton row with the stored brain mode (gbrain-store `persistence::worktrees::release`; classic until activated). */
export const readManagedModeRows: StoreMember<[], Array<{ enabled: unknown }>> = async (brain) =>
  [{ enabled: (await readBrainMode(brain, 'readManagedModeRows')).enabled }];

/** The brain's one process opens its store file, so it owns every table and may apply migrations. */
export const ownsSchemaTables: StoreMember<[], boolean> = async () => true;
