/**
 * Source-resolution members (BrainEngine listLocalPathSources, listSourceRoutingRows, countDefaultSourceSplit): the
 * typed reads source-resolver.ts makes instead of raw SQL. Store side: rust/crates/gbrain-store/src/cli_reads/sources.rs.
 * listStaleSyncSourceIds (the advisor's stale-sync read), listSourceIds (every source id), readSoleSourceId, readFirstSourceId, lockAllSourceRows
 * (takes no lock) and readSourceRow/lockSourceRow (one source's check columns)
 * read the store's source records here; lockSourceForUpdate (the publication transaction's exclusive source lock) is a no-op.
 * countSourcePages counts one source's pages, readSourcesNotReadable is the `sources_not_readable` test of an unscoped
 * remote read, insertSource creates a source and
 * advanceSourceCommit records the commit a git sync reached; listSourcePathPages, readRenameIdentityRows and
 * readLiveIdentityHolders are a git sync's page reads, readPageSizeRows its size-state read and listQuarantinedSlugs the
 * pages its link and timeline extraction skips; deleteSourceRecord and readSourceDeleteImpact are `sources remove` and
 * its preview (store side: the same cli_reads/sources.rs, sources.rs for advanceSourceCommit, and sources/archive.rs
 * for the delete). readPageIdentity is the held-rename redecision read; writeSourceSyncHeartbeat and
 * writeSourceUpstreamObservation are the sync's heartbeat and upstream observation (store side: sources.rs).
 * readSourceLastCommit reads the commit the sync anchor last advanced to, for the resident notifier (store side:
 * sources.rs).
 */
import type { SourceRecordRow } from '../../engine.ts';
import type { DefaultSourceSplit, LiveIdentityHolderRow, LocalPathSourceRow, PageIdentityRow, PageSizeRow, PlainSyncSourceRow, ReasonPurgeTombstone, RenameIdentityRow, SourceCheckRow, SourcesNotReadableOpts, SourceDeleteImpact, SourceDeleteResult, SourceInsert, SourcePathPageRow, SourceRoutingRow, SourceUpstreamObservation, SourcePathRow } from '../../engine-sql/sources.ts';
import type { StoreBrain } from '../store.ts';
import { assertStoreSerializedTransactions, storeCall, type StoreMember } from './common.ts';
import { refusing } from './constraint-errors.ts';
import { isOwnerOnlySourceConfig } from '../../access/owner-only.ts';
import { remoteReadFloorSql } from '../../search/private-visibility.ts';
import { storePageTextPolicy } from './private-provenance.ts';

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

/** Every source with a local path as `{ id, local_path }`: the store's local-path source rows without `archived`. */
export const listSourcePathRows: StoreMember<[], SourcePathRow[]> = async (brain) =>
  ((await storeCall({ member: 'listSourcePathRows' }, () => brain.listLocalPathSources())) as LocalPathSourceRow[]).map(({ id, local_path }) => ({ id, local_path }));

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

/** Every source id, archived ones included, by id bytewise (the store's source records). */
export const listSourceIds: StoreMember<[], string[]> = async (brain) => {
  const rows = (await storeCall({ member: 'listSourceIds' }, () => brain.listSourceRecords())) as SourceRecordRow[];
  return rows.map(r => r.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

/** The only source's id, or null when the store has none or several. */
export const readSoleSourceId: StoreMember<[], string | null> = async (brain) => {
  const rows = (await storeCall({ member: 'readSoleSourceId' }, () => brain.listSourceRecords())) as SourceRecordRow[];
  return rows.length === 1 ? rows[0]!.id : null;
};

/** `default` when the store has it, else the lowest id bytewise, else null. */
export const readFirstSourceId: StoreMember<[], string | null> = async (brain) => {
  const rows = (await storeCall({ member: 'readFirstSourceId' }, () => brain.listSourceRecords())) as SourceRecordRow[];
  const ids = rows.map(r => r.id);
  return ids.includes('default') ? 'default' : ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0] ?? null;
};

/** Takes no row lock while explicit transactions hold the writer (`serialized_transactions`); it asserts that. */
export const lockAllSourceRows: StoreMember<[mode: 'update' | 'share'], void> = async brain => {
  assertStoreSerializedTransactions(brain, 'lockAllSourceRows');
  // Multi-user mode (optimistic transactions): the lock becomes a read of every source row, so a source written before
  // the commit refuses it and the transaction runs again. Single-user mode reads nothing, as before.
  if (brain.multiuser === true) await storeCall({ member: 'lockAllSourceRows' }, () => brain.listSourceRecords());
};

async function sourceCheckRow(brain: StoreBrain, member: string, sourceId: string): Promise<SourceCheckRow | null> {
  const rows = (await storeCall({ member, sourceId }, () => brain.listSourceRecords())) as SourceRecordRow[];
  const row = rows.find(r => r.id === sourceId);
  return row ? { id: row.id, local_path: row.local_path, config: row.config, archived: row.archived === true } : null;
}

export const readSourceRow: StoreMember<[sourceId: string], SourceCheckRow | null> = (brain, sourceId) =>
  sourceCheckRow(brain, 'readSourceRow', sourceId);

/** Takes no row lock while explicit transactions hold the writer (`serialized_transactions`); it asserts that. */
export const lockSourceRow: StoreMember<[sourceId: string], SourceCheckRow | null> = async (brain, sourceId) => {
  assertStoreSerializedTransactions(brain, 'lockSourceRow');
  return sourceCheckRow(brain, 'lockSourceRow', sourceId);
};

/**
 * The publication transaction's exclusive source lock (`lockSourceForUpdate`, engine-sql/sources.ts). It takes no row lock and
 * calls no store function: the lock is skipped while explicit transactions hold the writer (`serialized_transactions`),
 * and the member asserts that, as `lockSourceRow` does.
 */
export const lockSourceForUpdate: StoreMember<[sourceId: string], void> = async (brain, sourceId) => {
  assertStoreSerializedTransactions(brain, 'lockSourceForUpdate');
  // Multi-user mode: the lock becomes a read of the source's row (an unknown source reads as absent, so a source added
  // before the commit refuses it). Single-user mode reads nothing, as before.
  if (brain.multiuser === true) await storeCall({ member: 'lockSourceForUpdate', sourceId }, () => brain.readSourceWriteRow(sourceId));
};

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

/** `insertReasonPurgeTombstones` (main's member): the (commit, path) pairs zip up the two lists; the store tombstones each pair, none twice, and answers how many it added. */
export const insertReasonPurgeTombstones: StoreMember<[sourceId: string, commits: string[], paths: string[]], number> = async (brain, sourceId, commits, paths) =>
  Number(await storeCall({ member: 'insertReasonPurgeTombstones', sourceId }, () => brain.writeReasonPurgeTombstones(sourceId, commits.map((commit, i) => ({ commit_sha: commit, path: paths[i]! })))));

/** The store's purge epoch advance (sources.rs `advance_source_purge_epoch`): the new epoch, or null for an unknown source. */
export const advanceSourcePurgeEpoch: StoreMember<[sourceId: string], number | null> = async (brain, sourceId) =>
  (await storeCall({ member: 'advanceSourcePurgeEpoch', sourceId }, () => brain.advanceSourcePurgeEpoch(sourceId))) as number | null;

export const listSourcePathPages: StoreMember<[sourceId: string], SourcePathPageRow[]> = async (brain, sourceId) =>
  (await storeCall({ member: 'listSourcePathPages', sourceId }, () => brain.listSourcePathPages(sourceId))) as SourcePathPageRow[];

export const listQuarantinedSlugs: StoreMember<[sourceId: string], string[]> = async (brain, sourceId) =>
  (await storeCall({ member: 'listQuarantinedSlugs', sourceId }, () => brain.listQuarantinedSlugs(sourceId))) as string[];

export const readRenameIdentityRows: StoreMember<[sourceId: string, paths: readonly string[], slugs: readonly string[]], RenameIdentityRow[]> = async (brain, sourceId, paths, slugs) =>
  (await storeCall({ member: 'readRenameIdentityRows', sourceId }, () => brain.readRenameIdentityRows(sourceId, [...paths], [...slugs]))) as RenameIdentityRow[];

export const readLiveIdentityHolders: StoreMember<[sourceId: string, ids: readonly string[], titles: readonly string[]], LiveIdentityHolderRow[]> = async (brain, sourceId, ids, titles) =>
  (await storeCall({ member: 'readLiveIdentityHolders', sourceId }, () => brain.readLiveIdentityHolders(sourceId, [...ids], [...titles]))) as LiveIdentityHolderRow[];

export const readPageIdentity: StoreMember<[pageId: number], PageIdentityRow | null> = (brain, pageId) =>
  storeCall({ member: 'readPageIdentity' }, () => brain.readPageIdentity(pageId));

/** last_sync_at is the store's clock, not a database `now()` (rust/docs/store/sources.md). */
export const advanceSourceCommit: StoreMember<[sourceId: string, commit: string, newestContentAt?: string | null], void> = async (brain, sourceId, commit, newestContentAt) => {
  await storeCall({ member: 'advanceSourceCommit', sourceId }, () => brain.advanceSourceCommit(sourceId, commit, newestContentAt !== undefined, newestContentAt ?? null));
};

export const writeSourceSyncHeartbeat: StoreMember<[sourceId: string], void> = async (brain, sourceId) => {
  await storeCall({ member: 'writeSourceSyncHeartbeat', sourceId }, () => brain.writeSourceSyncHeartbeat(sourceId));
};

export const writeSourceUpstreamObservation: StoreMember<[sourceId: string, observed: SourceUpstreamObservation], void> = async (brain, sourceId, observed) => {
  await storeCall({ member: 'writeSourceUpstreamObservation', sourceId }, () =>
    brain.writeSourceUpstreamObservation(sourceId, observed.checkedAt, observed.commit, observed.behind));
};

/**
 * The `sources_not_readable` test of an unscoped remote read (sources-not-readable.ts). `excludePrivate` sends the
 * remote read floor as the store page policy (storePageTextPolicy); a caller whose floor the store cannot apply refuses.
 */
export const readSourcesNotReadable: StoreMember<[readable: readonly string[], opts: SourcesNotReadableOpts], boolean> = async (brain, readable, opts) => {
  const member = 'readSourcesNotReadable';
  const policy = opts.excludePrivate ? storePageTextPolicy(member, () => remoteReadFloorSql('p'), { callerReaders: true, fragment: 'floor' }) : null;
  return (await storeCall({ member }, () => brain.readSourcesNotReadable([...readable], opts.facts, policy))) === true;
};

/**
 * A taken id or name refuses `constraint_violation`, as the SQL unique keys do; the store also refuses an id outside
 * `[a-z0-9-]{1,32}`. The binding drops a config key set to `undefined`, as
 * the SQL engines' JSON binding does.
 */
export const insertSource: StoreMember<[row: SourceInsert], void> = async (brain, row) => {
  await storeCall({ member: 'insertSource', sourceId: row.id }, () => brain.insertSource(row.id, row.name, row.local_path, row.config));
};

/**
 * Deletes the source (only an expired archive when `expiredArchiveOnly`, by the store's archive times) with its pages
 * and every record keyed by it in one store write; the pages always go with it, so `stranded` is 0. An OAuth client
 * whose source_id names the source refuses it as Postgres's oauth_clients_source_id_fkey (23503) does
 * (constraint-errors.ts).
 */
export const deleteSourceRecord: StoreMember<[sourceId: string, opts?: { expiredArchiveOnly?: boolean }], SourceDeleteResult> = async (brain, sourceId, opts) => ({
  deleted: (await refusing<boolean>('deleteSourceRecord', () => brain.deleteSourceRecord(sourceId, opts?.expiredArchiveOnly === true))) === true,
  stranded: 0,
});

/** The store keeps no `files` table, so `files` is 0; a source kept without a name reads with its id as the name. */
export const readSourceDeleteImpact: StoreMember<[sourceId: string], SourceDeleteImpact | null> = async (brain, sourceId) => {
  const r = (await storeCall({ member: 'readSourceDeleteImpact', sourceId }, () => brain.readSourceDeleteImpact(sourceId))) as (Omit<SourceDeleteImpact, 'name'> & { name: string | null }) | null;
  return r && { id: r.id, name: r.name ?? r.id, pages: Number(r.pages), chunks: Number(r.chunks), embeddings: Number(r.embeddings), files: Number(r.files), facts: Number(r.facts) };
};
/** The commit the source's last sync advanced to, or null. */
export const readSourceLastCommit: StoreMember<[sourceId: string], string | null> = async (brain, sourceId) =>
  await storeCall({ member: 'readSourceLastCommit', sourceId }, () => brain.readSourceLastCommit(sourceId)) as string | null;
