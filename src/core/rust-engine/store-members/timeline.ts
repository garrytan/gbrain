/**
 * Timeline members (BrainEngine addTimelineEntry, addTimelineEntriesBatch, getTimeline, readNewestTimelineEntryId). getTimeline takes the page
 * privacy policy of `excludePrivate` (storePagePolicy): a hidden page reads no rows, and an entry drops when the policy
 * hides its event page. A caller's reader identity and private-readable grant ride along (callerReaders). An
 * `eligibility` policy hides the rows of a soft-deleted or quarantined page (`projectionEligibleSql`), and its `floor`
 * and `suppressFlagged` filter each row by the tier its write stamped and its write-gate receipts. See
 * rust/docs/store/links-graph-timeline.md.
 */
import type { TimelineBatchInput } from '../../engine.ts';
import type { TimelineEntry, TimelineInput, TimelineOpts } from '../../types.ts';
import { toTimelineEntry } from '../store-codec.ts';
import { storeCall, takeOptions, throwIfAborted, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

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
  // engine-sql/timeline.ts getTimeline reads neither chunk safety nor a takes holder allow-list (readPolicyOpts sends both).
  const { eligibility, ...taken } = takeOptions('getTimeline', opts,
    ['limit', 'after', 'before', 'sourceId', 'sourceIds', 'excludePrivate', 'eligibility'], ['requireSafeChunks', 'takesHoldersAllowList']);
  const policy = eligibility as TimelineOpts['eligibility'];
  const scope = {
    ...taken, excludePrivate: storePagePolicy('getTimeline', taken.excludePrivate, { callerReaders: true }) ?? null,
    eligibleOnly: Boolean(policy), minTrust: policy?.floor ?? null, suppressFlagged: policy?.suppressFlagged === true,
  };
  const rows: TimelineEntry[] = await storeCall({ member: 'getTimeline', slug }, () => brain.getTimeline(slug, scope));
  return rows.map((row) => toTimelineEntry(row));
};

export const readNewestTimelineEntryId: StoreMember<[sourceId: string, slug: string, date: string, summary: string], number | null> =
  async (brain, sourceId, slug, date, summary) => {
    const id: number | null = await storeCall({ member: 'readNewestTimelineEntryId', slug, sourceId }, () => brain.readNewestTimelineEntryId(sourceId, slug, date, summary));
    return id === null || id === undefined ? null : Number(id);
  };
