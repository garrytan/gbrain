/**
 * The stored brain mode read that several store members share (writer release, the journal's managed-mode and ledger
 * reads, the import reads). A helper, not a member: index.ts does not spread this module into STORE_MEMBERS, so the
 * member table (members.ts) needs no row for it.
 */
import type { StoreBrain } from '../store.ts';
import { storeCall } from './common.ts';

/** The stored brain mode: `enabled` and `mode_epoch` (text) of the persistence brain row. */
export async function readBrainMode(brain: StoreBrain, member: string): Promise<{ enabled: boolean; mode_epoch: string }> {
  return storeCall({ member }, () => brain.writerReleaseRows({ kind: 'brain_mode' }));
}
