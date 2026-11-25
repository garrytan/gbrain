/**
 * Source-resolution members (BrainEngine listLocalPathSources, listSourceRoutingRows, countDefaultSourceSplit, readSourceRow) served by
 * gbrain-store `cli_reads::sources` and `cli_reads::import` (rust/docs/store/sources.md).
 */
import type { SourceRecordRow } from '../../engine.ts';
import type { ActiveSourceConfigRow, DefaultSourceSplit, LocalPathSourceRow, SourceCheckRow, SourceRoutingRow } from '../../engine-sql/sources.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';

export const listLocalPathSources: StoreMember<[], LocalPathSourceRow[]> = async (brain) =>
  (await storeCall({ member: 'listLocalPathSources' }, () => brain.listLocalPathSources())) as LocalPathSourceRow[];

export const listSourceRoutingRows: StoreMember<[], SourceRoutingRow[]> = async (brain) =>
  (await storeCall({ member: 'listSourceRoutingRows' }, () => brain.listSourceRoutingRows())) as SourceRoutingRow[];

export const countDefaultSourceSplit: StoreMember<[], DefaultSourceSplit> = async (brain) =>
  (await storeCall({ member: 'countDefaultSourceSplit' }, () => brain.countDefaultSourceSplit())) as DefaultSourceSplit;

async function sourceCheckRow(brain: StoreBrain, member: string, sourceId: string): Promise<SourceCheckRow | null> {
  const rows = (await storeCall({ member, sourceId }, () => brain.listSourceRecords())) as SourceRecordRow[];
  const row = rows.find(r => r.id === sourceId);
  return row ? { id: row.id, local_path: row.local_path, config: row.config, archived: row.archived === true } : null;
}

export const readSourceRow: StoreMember<[sourceId: string], SourceCheckRow | null> = (brain, sourceId) =>
  sourceCheckRow(brain, 'readSourceRow', sourceId);

/** The active sources with their raw config, from the store's source records (it keeps no separate statement for them). */
export const listActiveSourceConfigs: StoreMember<[], ActiveSourceConfigRow[]> = async (brain) => {
  const rows = (await storeCall({ member: 'listActiveSourceConfigs' }, () => brain.listSourceRecords())) as SourceRecordRow[];
  return rows.filter(row => row.archived !== true).map(({ id, config }) => ({ id, config, archived: false }));
};
