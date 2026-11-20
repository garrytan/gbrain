/**
 * Source-resolution members (BrainEngine listLocalPathSources, listSourceRoutingRows, countDefaultSourceSplit): the
 * typed reads source-resolver.ts makes instead of raw SQL. Store side: rust/crates/gbrain-store/src/cli_reads/sources.rs.
 * listStaleSyncSourceIds (the advisor's stale-sync read) and readSourceRow/lockSourceRow (one source's check columns)
 * read the store's source records here. countSourcePages counts one source's pages, insertSource creates a source and
 * advanceSourceCommit records the commit a git sync reached; listSourcePathPages, readRenameIdentityRows and
 * readLiveIdentityHolders are a git sync's page reads, readPageSizeRows its size-state read and listQuarantinedSlugs the
 * pages its link and timeline extraction skips (store side: the same cli_reads/sources.rs, and sources.rs for
 * advanceSourceCommit).
 */
import type { SourceRecordRow } from '../../engine.ts';
import type { DefaultSourceSplit, LiveIdentityHolderRow, LocalPathSourceRow, PageSizeRow, PlainSyncSourceRow, ReasonPurgeTombstone, RenameIdentityRow, SourceCheckRow, SourceInsert, SourcePathPageRow, SourceRoutingRow } from '../../engine-sql/sources.ts';
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

/** `state` and `reason` are the page's embedding hold (rust/docs/store/sources.md), else null. */
export const readPageSizeRows: StoreMember<[sourceId: string, maxBytes: number, slugs: readonly string[] | null], PageSizeRow[]> = async (brain, sourceId, maxBytes, slugs) =>
  (await storeCall({ member: 'readPageSizeRows', sourceId }, () => brain.readPageSizeRows(sourceId, maxBytes, slugs ? [...slugs] : null))) as PageSizeRow[];

export const holdPageEmbedding: StoreMember<[pageId: number, reason: string], void> = async (brain, pageId, reason) => {
  await storeCall({ member: 'holdPageEmbedding' }, () => brain.holdPageEmbedding(pageId, reason));
};

export const readReasonPurgeTombstones: StoreMember<[sourceId: string, pair?: ReasonPurgeTombstone], ReasonPurgeTombstone[]> = async (brain, sourceId, pair) =>
  (await storeCall({ member: 'readReasonPurgeTombstones', sourceId }, () => brain.readReasonPurgeTombstones(sourceId, pair ?? null))) as ReasonPurgeTombstone[];

export const writeReasonPurgeTombstones: StoreMember<[sourceId: string, pairs: readonly ReasonPurgeTombstone[]], number> = async (brain, sourceId, pairs) =>
  Number(await storeCall({ member: 'writeReasonPurgeTombstones', sourceId }, () => brain.writeReasonPurgeTombstones(sourceId, pairs.map(pair => ({ commit_sha: pair.commit_sha, path: pair.path })))));

export const listSourcePathPages: StoreMember<[sourceId: string], SourcePathPageRow[]> = async (brain, sourceId) =>
  (await storeCall({ member: 'listSourcePathPages', sourceId }, () => brain.listSourcePathPages(sourceId))) as SourcePathPageRow[];

export const listQuarantinedSlugs: StoreMember<[sourceId: string], string[]> = async (brain, sourceId) =>
  (await storeCall({ member: 'listQuarantinedSlugs', sourceId }, () => brain.listQuarantinedSlugs(sourceId))) as string[];

export const readRenameIdentityRows: StoreMember<[sourceId: string, paths: readonly string[], slugs: readonly string[]], RenameIdentityRow[]> = async (brain, sourceId, paths, slugs) =>
  (await storeCall({ member: 'readRenameIdentityRows', sourceId }, () => brain.readRenameIdentityRows(sourceId, [...paths], [...slugs]))) as RenameIdentityRow[];

export const readLiveIdentityHolders: StoreMember<[sourceId: string, ids: readonly string[], titles: readonly string[]], LiveIdentityHolderRow[]> = async (brain, sourceId, ids, titles) =>
  (await storeCall({ member: 'readLiveIdentityHolders', sourceId }, () => brain.readLiveIdentityHolders(sourceId, [...ids], [...titles]))) as LiveIdentityHolderRow[];

/** last_sync_at is the store's clock, not a database `now()` (rust/docs/store/sources.md). */
export const advanceSourceCommit: StoreMember<[sourceId: string, commit: string, newestContentAt?: string | null], void> = async (brain, sourceId, commit, newestContentAt) => {
  await storeCall({ member: 'advanceSourceCommit', sourceId }, () => brain.advanceSourceCommit(sourceId, commit, newestContentAt !== undefined, newestContentAt ?? null));
};

/**
 * A taken id or name refuses `constraint_violation`, as the SQL unique keys do; the store also refuses an id outside
 * `[a-z0-9-]{1,32}`. The binding drops a config key set to `undefined`, as
 * the SQL engines' JSON binding does.
 */
export const insertSource: StoreMember<[row: SourceInsert], void> = async (brain, row) => {
  await storeCall({ member: 'insertSource', sourceId: row.id }, () => brain.insertSource(row.id, row.name, row.local_path, row.config));
};
