/** Timeline members (BrainEngine addTimelineEntry, addTimelineEntriesBatch, getTimeline). */
import type { TimelineBatchInput } from '../../engine.ts';
import type { TimelineEntry, TimelineInput, TimelineOpts } from '../../types.ts';
import { toTimelineEntry } from '../store-codec.ts';
import { storeCall, takeOptions, throwIfAborted, type StoreMember } from './common.ts';

export const addTimelineEntry: StoreMember<[slug: string, entry: TimelineInput, opts?: { skipExistenceCheck?: boolean; sourceId?: string }], boolean> =
  (brain, slug, entry, opts) => {
    const scope = takeOptions('addTimelineEntry', opts, ['skipExistenceCheck', 'sourceId']);
    return storeCall({ member: 'addTimelineEntry', slug, sourceId: scope.sourceId as string | undefined }, () => brain.addTimelineEntry(slug, entry, scope));
  };

export const addTimelineEntriesBatch: StoreMember<[entries: TimelineBatchInput[], opts?: { auditSite?: unknown; signal?: AbortSignal }], number> = (brain, entries, opts) => {
  takeOptions('addTimelineEntriesBatch', opts, [], ['auditSite', 'signal']);
  throwIfAborted(opts?.signal);
  return storeCall({ member: 'addTimelineEntriesBatch' }, () => brain.addTimelineEntriesBatch(entries));
};

export const getTimeline: StoreMember<[slug: string, opts?: TimelineOpts], TimelineEntry[]> = async (brain, slug, opts) => {
  const scope = takeOptions('getTimeline', opts, ['limit', 'after', 'before', 'sourceId', 'sourceIds']);
  const rows: TimelineEntry[] = await storeCall({ member: 'getTimeline', slug }, () => brain.getTimeline(slug, scope));
  return rows.map((row) => toTimelineEntry(row));
};
