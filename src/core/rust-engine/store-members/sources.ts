/** Source members (BrainEngine listAllSources, updateSourceConfig, replaceSourceConfig, renameSource, markSourceSynced, advanceSyncCheckpoint, readLiveSlugAliases, readSourceSlugProbe, readStoredSlugSpellings, getSource, listSourceLocalPaths, countRepoBoundSources, getSourceStrictness). */
import type { SourceDetailRow, SourceRow } from '../../engine.ts';
import type { SourceSyncStampOptions, SyncCheckpointAdvance } from '../../engine-sql/sources.ts';
import type { LiveSlugAliasRow, SourceSlugProbe } from '../../engine-sql/link-slug-reads.ts';
import type { StoredSpellingScope } from '../../engine-sql/slug-spellings.ts';
import type { FederationExposedRow } from '../../engine-sql/federation-exposure.ts';
import { privacyAliasSql, privateSnapshotFilterFragment } from '../../search/private-visibility.ts';
import { toSource, withDates } from '../store-codec.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';

export const listAllSources: StoreMember<[opts?: { includeArchived?: boolean; localPathOnly?: boolean }], SourceRow[]> = async (brain, opts) => {
  const rows = await storeCall({ member: 'listAllSources' }, () =>
    brain.listAllSources(takeOptions('listAllSources', opts, ['includeArchived', 'localPathOnly'])));
  return (rows as SourceRow[]).map((row) => toSource(row));
};

export const updateSourceConfig: StoreMember<[sourceId: string, patch: Record<string, unknown>], boolean> = (brain, sourceId, patch) =>
  storeCall({ member: 'updateSourceConfig', sourceId }, () => brain.updateSourceConfig(sourceId, patch));

/** Sets the source's display name; false for an unknown source, which changes nothing. */
export const renameSource: StoreMember<[sourceId: string, name: string], boolean> = (brain, sourceId, name) =>
  storeCall({ member: 'renameSource', sourceId }, () => brain.renameSource(sourceId, name));

/**
 * The federation warning's exposed pages. `honorAliases` is read off the rendered snapshot filter, the process setting
 * the SQL engines render into `privacyPartSql`; the store keeps no access tokens, so a token writer binds no member.
 */
export const readFederationExposedPages: StoreMember<[sourceId: string, hidePrivate: boolean], FederationExposedRow[]> = (brain, sourceId, hidePrivate) => {
  const honorAliases = privateSnapshotFilterFragment('p').includes(privacyAliasSql('p'));
  return storeCall({ member: 'readFederationExposedPages', sourceId }, () => brain.readFederationExposedPages(sourceId, hidePrivate, honorAliases)) as Promise<FederationExposedRow[]>;
};

/** Link preparation's live alias targets; the store answers in alias byte order (the SQL states no order). */
export const readLiveSlugAliases: StoreMember<[sourceId: string, targets: readonly string[]], LiveSlugAliasRow[]> = async (brain, sourceId, targets) =>
  targets.length ? storeCall({ member: 'readLiveSlugAliases', sourceId }, () => brain.readLiveSlugAliases(sourceId, [...targets])) as Promise<LiveSlugAliasRow[]> : [];

/** Link preparation's slug fingerprint; the store's hash is its own (a sum of per-slug FNV-1a hashes), as the caller only compares it with itself. */
export const readSourceSlugProbe: StoreMember<[sourceId: string, afterId: number], SourceSlugProbe> = (brain, sourceId, afterId) =>
  storeCall({ member: 'readSourceSlugProbe', sourceId }, () => brain.readSourceSlugProbe(sourceId, afterId)) as Promise<SourceSlugProbe>;

/** A scalar slug read's stored-spelling scan; the store keys each stored slug as `SPELLING_KEY_SQL` does (slug_spellings.rs). */
export const readStoredSlugSpellings: StoreMember<[key: string, scope: StoredSpellingScope, after: string], string[]> = (brain, key, scope, after) =>
  storeCall({ member: 'readStoredSlugSpellings', ...(scope.sourceId !== undefined ? { sourceId: scope.sourceId } : {}) }, () =>
    brain.readStoredSlugSpellings(key, scope.sourceId ?? null, scope.sourceIds ? [...scope.sourceIds] : null, after)) as Promise<string[]>;

/** Sets the source's last sync time to the store clock; false for an unknown source (or another incarnation), which changes nothing. */
export const markSourceSynced: StoreMember<[sourceId: string, opts?: SourceSyncStampOptions], boolean> = (brain, sourceId, opts) =>
  storeCall({ member: 'markSourceSynced', sourceId }, () => brain.markSourceSynced(sourceId, takeOptions('markSourceSynced', opts, ['incarnation', 'newestContentAt'])));

/** The managed sync checkpoint; the store reads the source record and its live pages in one write transaction. */
export const advanceSyncCheckpoint: StoreMember<[input: SyncCheckpointAdvance], { advanced: boolean; pinnedSlugMode: string | null }> = (brain, input) =>
  storeCall({ member: 'advanceSyncCheckpoint', sourceId: input.sourceId }, () => brain.advanceSyncCheckpoint({
    sourceId: input.sourceId, incarnation: input.incarnation, commit: input.commit, from: input.from,
    acceptAtCommit: input.acceptAtCommit, slugMode: input.slugMode, keepPinnedSlugMode: input.keepPinnedSlugMode,
  })) as Promise<{ advanced: boolean; pinnedSlugMode: string | null }>;

/**
 * The row or null; `created_at` and `last_sync_at` come back as Dates, like the driver's. The store keeps the source's
 * own contextual-retrieval mode beside the source record (source_cr_mode.rs), so it is read with a second call.
 */
export const getSource: StoreMember<[sourceId: string], SourceDetailRow | null> = async (brain, sourceId) => {
  const row = await storeCall({ member: 'getSource', sourceId }, () => brain.getSource(sourceId));
  if (!row) return null;
  const mode: string | null = await storeCall({ member: 'getSource', sourceId }, () => brain.readSourceContextualMode(sourceId));
  return withDates({ ...(row as SourceDetailRow), contextual_retrieval_mode: mode ?? null }, ['last_sync_at', 'created_at']);
};

export const countRepoBoundSources: StoreMember<[], number> = async (brain) =>
  Number(await storeCall({ member: 'countRepoBoundSources' }, () => brain.countRepoBoundSources()));

export const listSourceLocalPaths: StoreMember<[], string[]> = (brain) =>
  storeCall({ member: 'listSourceLocalPaths' }, () => brain.listSourceLocalPaths());

export const getSourceStrictness: StoreMember<[sourceId: string], boolean> = (brain, sourceId) =>
  storeCall({ member: 'getSourceStrictness', sourceId }, () => brain.getSourceStrictness(sourceId));
