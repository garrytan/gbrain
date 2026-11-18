/** Source members (BrainEngine listAllSources, updateSourceConfig). */
import type { SourceRow } from '../../engine.ts';
import { toSource } from '../store-codec.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';

export const listAllSources: StoreMember<[opts?: { includeArchived?: boolean; localPathOnly?: boolean }], SourceRow[]> = async (brain, opts) => {
  const rows = await storeCall({ member: 'listAllSources' }, () =>
    brain.listAllSources(takeOptions('listAllSources', opts, ['includeArchived', 'localPathOnly'])));
  return (rows as SourceRow[]).map((row) => toSource(row));
};

export const updateSourceConfig: StoreMember<[sourceId: string, patch: Record<string, unknown>], boolean> = (brain, sourceId, patch) =>
  storeCall({ member: 'updateSourceConfig', sourceId }, () => brain.updateSourceConfig(sourceId, patch));
