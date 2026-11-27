/**
 * The persistence state members the import and put paths reach (BrainEngine readManagedModeRows, ownsSchemaTables,
 * readLocalWriterRow, insertLocalWriterRow): the one brain row's stored mode, the store owning its
 * own tables, and the local writer registration every CLI write checks (persistence/identity.ts registerLocalWriter).
 */
import type { LocalWriterInsert, LocalWriterRow } from '../../engine-sql/persistence-state.ts';
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

/**
 * The registration row of a local writer, or undefined. `lock` asks PGLite for FOR SHARE so a revocation waits; the
 * store runs one write transaction at a time, so a read never overlaps a revocation and the option changes nothing.
 * `revoked_at` comes back as a Date, as PGLite returns a timestamptz.
 */
export const readLocalWriterRow: StoreMember<[id: string, opts?: { lock?: boolean }], LocalWriterRow | undefined> =
  async (brain, id) => {
    const row = await storeCall({ member: 'readLocalWriterRow' }, () => brain.readLocalWriter(id)) as
      { lane: string; credential_hash: string; grant_ceiling: LocalWriterRow['grant_ceiling']; revoked_at: string | null } | null;
    if (!row) return undefined;
    return { lane: row.lane, credential_hash: row.credential_hash, grant_ceiling: row.grant_ceiling, revoked_at: row.revoked_at === null ? null : new Date(row.revoked_at) };
  };

/** Stores a local writer unless its id or credential hash is registered already; true when this call stored it. */
export const insertLocalWriterRow: StoreMember<[row: LocalWriterInsert], boolean> = (brain, row) =>
  storeCall({ member: 'insertLocalWriterRow' }, () => brain.insertLocalWriterRow({
    id: row.id, lane: row.lane, credentialHash: row.credentialHash, grantCeiling: row.grant,
  }));
