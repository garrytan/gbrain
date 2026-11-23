/** Source members (BrainEngine listAllSources, updateSourceConfig, markSourceSynced, advanceSyncCheckpoint, getSource, listSourceLocalPaths, countRepoBoundSources, getSourceStrictness). */
import type { SourceDetailRow, SourceRow } from '../../engine.ts';
import type { SourceSyncStampOptions, SyncCheckpointAdvance } from '../../engine-sql/sources.ts';
import { toSource, withDates } from '../store-codec.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';

export const listAllSources: StoreMember<[opts?: { includeArchived?: boolean; localPathOnly?: boolean }], SourceRow[]> = async (brain, opts) => {
  const rows = await storeCall({ member: 'listAllSources' }, () =>
    brain.listAllSources(takeOptions('listAllSources', opts, ['includeArchived', 'localPathOnly'])));
  return (rows as SourceRow[]).map((row) => toSource(row));
};

export const updateSourceConfig: StoreMember<[sourceId: string, patch: Record<string, unknown>], boolean> = (brain, sourceId, patch) =>
  storeCall({ member: 'updateSourceConfig', sourceId }, () => brain.updateSourceConfig(sourceId, patch));

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
