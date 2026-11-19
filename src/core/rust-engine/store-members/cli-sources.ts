/**
 * Source-resolution members (BrainEngine listLocalPathSources, listSourceRoutingRows, countDefaultSourceSplit): the
 * typed reads source-resolver.ts makes instead of raw SQL. Store side: rust/crates/gbrain-store/src/cli_reads/sources.rs.
 * listStaleSyncSourceIds (the advisor's stale-sync read) and readSourceRow/lockSourceRow (one source's check columns)
 * read the store's source records here. countSourcePages counts one source's pages and insertSource creates a source
 * (store side: the same cli_reads/sources.rs).
 */
import type { SourceRecordRow } from '../../engine.ts';
import type { DefaultSourceSplit, LocalPathSourceRow, PlainSyncSourceRow, SourceCheckRow, SourceInsert, SourceRoutingRow } from '../../engine-sql/sources.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';
import { isOwnerOnlySourceConfig } from '../../access/owner-only.ts';

/** Any owner-only source, archived ones included: the store's source rows tested with the rule access/owner-only.ts states. */
export const readOwnerOnlySourcesPresent: StoreMember<[], boolean> = async (brain) => {
  const rows = (await storeCall({ member: 'readOwnerOnlySourcesPresent' }, () => brain.listSourceRoutingRows())) as SourceRoutingRow[];
  return rows.some(row => isOwnerOnlySourceConfig(row.config));
};

/** One source's config (archived or not), or null when the store has no such source. */
export const readOwnerOnlySourceConfig: StoreMember<[sourceId: string], { config: unknown } | null> = async (brain, sourceId) => {
  const rows = (await storeCall({ member: 'readOwnerOnlySourceConfig', sourceId }, () => brain.listSourceRoutingRows())) as SourceRoutingRow[];
  const row = rows.find(r => r.id === sourceId);
  return row ? { config: row.config } : null;
};

export const readPlainSyncSource: StoreMember<[sourceId: string], PlainSyncSourceRow | null> = async (brain, sourceId) =>
  (await storeCall({ member: 'readPlainSyncSource', sourceId }, () => brain.readPlainSyncSource(sourceId))) as PlainSyncSourceRow | null;

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

export const countSourcePages: StoreMember<[sourceId: string, opts?: { includeDeleted?: boolean }], number> = async (brain, sourceId, opts) =>
  Number(await storeCall({ member: 'countSourcePages', sourceId }, () => brain.countSourcePages(sourceId, opts?.includeDeleted === true)));

/**
 * A taken id or name refuses `constraint_violation`, as the SQL unique keys do; the store also refuses an id outside
 * `[a-z0-9-]{1,32}`. The binding drops a config key set to `undefined`, as
 * the SQL engines' JSON binding does.
 */
export const insertSource: StoreMember<[row: SourceInsert], void> = async (brain, row) => {
  await storeCall({ member: 'insertSource', sourceId: row.id }, () => brain.insertSource(row.id, row.name, row.local_path, row.config));
};
