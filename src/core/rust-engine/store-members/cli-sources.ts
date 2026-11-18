/**
 * Source-resolution members (BrainEngine listLocalPathSources, listSourceRoutingRows, countDefaultSourceSplit): the
 * typed reads source-resolver.ts makes instead of raw SQL. Store side: rust/crates/gbrain-store/src/cli_reads/sources.rs.
 * listStaleSyncSourceIds (the advisor's stale-sync read) and readSourceRow/lockSourceRow (one source's check columns)
 * read the store's source records here.
 */
import type { SourceRecordRow } from '../../engine.ts';
import type { DefaultSourceSplit, LocalPathSourceRow, SourceCheckRow, SourceRoutingRow } from '../../engine-sql/sources.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';

export const listLocalPathSources: StoreMember<[], LocalPathSourceRow[]> = async (brain) =>
  (await storeCall({ member: 'listLocalPathSources' }, () => brain.listLocalPathSources())) as LocalPathSourceRow[];

export const listSourceRoutingRows: StoreMember<[], SourceRoutingRow[]> = async (brain) =>
  (await storeCall({ member: 'listSourceRoutingRows' }, () => brain.listSourceRoutingRows())) as SourceRoutingRow[];

export const countDefaultSourceSplit: StoreMember<[], DefaultSourceSplit> = async (brain) =>
  (await storeCall({ member: 'countDefaultSourceSplit' }, () => brain.countDefaultSourceSplit())) as DefaultSourceSplit;

/**
 * Live sources last synced more than seven days ago, by id. PGLite and Postgres compare with the database clock
 * (`now()`); the Rust store has no database clock, so this compares with the process clock.
 */
export const listStaleSyncSourceIds: StoreMember<[], string[]> = async (brain) => {
  const rows = (await storeCall({ member: 'listStaleSyncSourceIds' }, () => brain.listAllSources({}))) as Array<{ id: string; last_sync_at: string | null }>;
  const staleBefore = Date.now() - 7 * 86_400_000;
  return rows.filter(r => r.last_sync_at !== null && new Date(r.last_sync_at).getTime() < staleBefore).map(r => r.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

async function sourceCheckRow(brain: StoreBrain, member: string, sourceId: string): Promise<SourceCheckRow | null> {
  const rows = (await storeCall({ member, sourceId }, () => brain.listSourceRecords())) as SourceRecordRow[];
  const row = rows.find(r => r.id === sourceId);
  return row ? { id: row.id, local_path: row.local_path, config: row.config, archived: row.archived === true } : null;
}

export const readSourceRow: StoreMember<[sourceId: string], SourceCheckRow | null> = (brain, sourceId) =>
  sourceCheckRow(brain, 'readSourceRow', sourceId);

/** The store serializes its writes and the Rust engine runs no SQL transaction, so there is no row lock to take. */
export const lockSourceRow: StoreMember<[sourceId: string], SourceCheckRow | null> = (brain, sourceId) =>
  sourceCheckRow(brain, 'lockSourceRow', sourceId);
