/**
 * Timeline members (BrainEngine addTimelineEntry, addTimelineEntriesBatch, getTimeline). getTimeline takes the page
 * privacy policy of `excludePrivate` (storePagePolicy): a hidden page reads no rows, and an entry drops when the policy
 * hides its event page. An `eligibility` policy hides the rows of a soft-deleted or quarantined page
 * (`projectionEligibleSql`); one with `floor` or `suppressFlagged` refuses, as the store keeps no `trust_tier` or
 * write-gate receipts on timeline rows. See rust/docs/store/links-graph-timeline.md.
 */
import type { TimelineBatchInput } from '../../engine.ts';
import type { TimelineEntry, TimelineInput, TimelineOpts } from '../../types.ts';
import { toTimelineEntry } from '../store-codec.ts';
import { refuseMember, storeCall, takeOptions, throwIfAborted, type StoreMember } from './common.ts';
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
  const { eligibility, ...taken } = takeOptions('getTimeline', opts, ['limit', 'after', 'before', 'sourceId', 'sourceIds', 'excludePrivate', 'eligibility']);
  const policy = eligibility as TimelineOpts['eligibility'];
  if (policy?.floor) refuseMember('getTimeline', 'option eligibility.floor');
  if (policy?.suppressFlagged) refuseMember('getTimeline', 'option eligibility.suppressFlagged');
  const scope = { ...taken, excludePrivate: storePagePolicy('getTimeline', taken.excludePrivate) ?? null, eligibleOnly: Boolean(policy) };
  const rows: TimelineEntry[] = await storeCall({ member: 'getTimeline', slug }, () => brain.getTimeline(slug, scope));
  return rows.map((row) => toTimelineEntry(row));
};
