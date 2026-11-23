/**
 * The two source reads `gbrain files` makes (src/core/engine-sql/files-ops.ts): `sourceIdExists` and
 * `readSourceLocalPathForVerify`. Both read the store's source records, as `readSourceRow` does, so an archived source
 * still exists and still has its checkout path.
 *
 * A source id with a NUL byte refuses rather than guess at the error the SQL engines raise for a NUL in text.
 */
import type { SourceRecordRow } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import type { StoreBrain } from '../store.ts';

async function sourceRecord(brain: StoreBrain, member: string, sourceId: string): Promise<SourceRecordRow | undefined> {
  if (sourceId.includes('\0')) refuseMember(member, 'a source id with a NUL byte');
  const rows = (await storeCall({ member, sourceId }, () => brain.listSourceRecords())) as SourceRecordRow[];
  return rows.find(r => r.id === sourceId);
}

export const sourceIdExists: StoreMember<[sourceId: string], boolean> = async (brain, sourceId) =>
  (await sourceRecord(brain, 'sourceIdExists', sourceId)) !== undefined;

/** The checkout path, null when the source has none (or an empty one) or does not exist. */
export const readSourceLocalPathForVerify: StoreMember<[sourceId: string], string | null> = async (brain, sourceId) => {
  const row = await sourceRecord(brain, 'readSourceLocalPathForVerify', sourceId);
  return row?.local_path ? String(row.local_path) : null;
};
