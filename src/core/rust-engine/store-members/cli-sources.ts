/**
 * Source-resolution members (BrainEngine listLocalPathSources, listSourceRoutingRows, countDefaultSourceSplit): the
 * typed reads source-resolver.ts makes instead of raw SQL. Store side: rust/crates/gbrain-store/src/cli_reads/sources.rs.
 * listStaleSyncSourceIds (the advisor's stale-sync read) and readSourceRow/lockSourceRow (one source's check columns)
 * read the store's source records here. countSourcePages counts one source's pages and insertSource creates a source
 * (store side: the same cli_reads/sources.rs). writeSourceCommitAnchor and writeSourceLocalPath are the sync anchor
 * writes, writeSourceUpstreamObservation the sync's upstream observation (store side: sources.rs).
 */
import type { SourceRecordRow } from '../../engine.ts';
import type { DefaultSourceSplit, LocalPathSourceRow, PlainSyncSourceRow, SourceCheckRow, SourceInsert, SourcePagePath, RenameStoredTitle, LiveIdentityHolder, PageIdentityRow, SourceRoutingRow, SourceUpstreamObservation } from '../../engine-sql/sources.ts';
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

export const listSourcePagePaths: StoreMember<[sourceId: string], SourcePagePath[]> = (brain, sourceId) =>
  storeCall({ member: 'listSourcePagePaths', sourceId }, () => brain.listSourcePagePaths(sourceId));

/** The rename confirmation reads (sync-rename-identity.ts); the store holds no value it cannot compare, so none refuses 22021. */
export const readRenameStoredTitles: StoreMember<[sourceId: string, paths: readonly string[], slugs: readonly string[]], RenameStoredTitle[]> = (brain, sourceId, paths, slugs) =>
  storeCall({ member: 'readRenameStoredTitles', sourceId }, () => brain.readRenameStoredTitles(sourceId, [...paths], [...slugs]));

export const readLiveIdentityHolders: StoreMember<[sourceId: string, ids: readonly string[], titles: readonly string[]], LiveIdentityHolder[]> = (brain, sourceId, ids, titles) =>
  storeCall({ member: 'readLiveIdentityHolders', sourceId }, () => brain.readLiveIdentityHolders(sourceId, [...ids], [...titles]));

export const readPageIdentity: StoreMember<[pageId: number], PageIdentityRow | null> = (brain, pageId) =>
  storeCall({ member: 'readPageIdentity' }, () => brain.readPageIdentity(pageId));

export const countSourcePages: StoreMember<[sourceId: string, opts?: { includeDeleted?: boolean }], number> = async (brain, sourceId, opts) =>
  Number(await storeCall({ member: 'countSourcePages', sourceId }, () => brain.countSourcePages(sourceId, opts?.includeDeleted === true)));

/** The sync anchor advance; the store stamps `last_sync_at` from the process clock (rust/docs/store/sources.md). */
export const writeSourceCommitAnchor: StoreMember<[sourceId: string, commit: string, opts?: { newestContentAt: string | null }], void> = async (brain, sourceId, commit, opts) => {
  await storeCall({ member: 'writeSourceCommitAnchor', sourceId }, () => brain.writeSourceCommitAnchor(sourceId, commit, opts !== undefined, opts?.newestContentAt ?? null));
};

export const writeSourceLocalPath: StoreMember<[sourceId: string, localPath: string], void> = async (brain, sourceId, localPath) => {
  await storeCall({ member: 'writeSourceLocalPath', sourceId }, () => brain.writeSourceLocalPath(sourceId, localPath));
};

export const writeSourceSyncHeartbeat: StoreMember<[sourceId: string], void> = async (brain, sourceId) => {
  await storeCall({ member: 'writeSourceSyncHeartbeat', sourceId }, () => brain.writeSourceSyncHeartbeat(sourceId));
};

export const writeSourceUpstreamObservation: StoreMember<[sourceId: string, observed: SourceUpstreamObservation], void> = async (brain, sourceId, observed) => {
  await storeCall({ member: 'writeSourceUpstreamObservation', sourceId }, () =>
    brain.writeSourceUpstreamObservation(sourceId, observed.checkedAt, observed.commit, observed.behind));
};

/**
 * A taken id or name refuses `constraint_violation`, as the SQL unique keys do; the store also refuses an id outside
 * `[a-z0-9-]{1,32}`. The binding drops a config key set to `undefined`, as
 * the SQL engines' JSON binding does.
 */
export const insertSource: StoreMember<[row: SourceInsert], void> = async (brain, row) => {
  await storeCall({ member: 'insertSource', sourceId: row.id }, () => brain.insertSource(row.id, row.name, row.local_path, row.config));
};
