/** Source members (BrainEngine listAllSources, updateSourceConfig, getSource, listSourceLocalPaths, getSourceStrictness). */
import type { SourceDetailRow, SourceRow } from '../../engine.ts';
import { toSource, withDates } from '../store-codec.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';

export const listAllSources: StoreMember<[opts?: { includeArchived?: boolean; localPathOnly?: boolean }], SourceRow[]> = async (brain, opts) => {
  const rows = await storeCall({ member: 'listAllSources' }, () =>
    brain.listAllSources(takeOptions('listAllSources', opts, ['includeArchived', 'localPathOnly'])));
  return (rows as SourceRow[]).map((row) => toSource(row));
};

export const updateSourceConfig: StoreMember<[sourceId: string, patch: Record<string, unknown>], boolean> = (brain, sourceId, patch) =>
  storeCall({ member: 'updateSourceConfig', sourceId }, () => brain.updateSourceConfig(sourceId, patch));

/** The row or null; `created_at` and `last_sync_at` come back as Dates, like the driver's. */
export const getSource: StoreMember<[sourceId: string], SourceDetailRow | null> = async (brain, sourceId) => {
  const row = await storeCall({ member: 'getSource', sourceId }, () => brain.getSource(sourceId));
  return row ? withDates(row as SourceDetailRow, ['last_sync_at', 'created_at']) : null;
};

export const listSourceLocalPaths: StoreMember<[], string[]> = (brain) =>
  storeCall({ member: 'listSourceLocalPaths' }, () => brain.listSourceLocalPaths());

export const getSourceStrictness: StoreMember<[sourceId: string], boolean> = (brain, sourceId) =>
  storeCall({ member: 'getSourceStrictness', sourceId }, () => brain.getSourceStrictness(sourceId));
