/**
 * Timeline reads by date: the Life Chronicle reads (BrainEngine getTimelineForDate, getSince, getOnThisDay,
 * getLastSeen) and the event projection write (upsertEventProjection).
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 */
import { finalizeLastSeen } from '../../chronicle/last-seen.ts';
import type { ChronicleTimelineOpts, ChronicleTimelineRow, LastSeenResult, PageReadScope } from '../../types.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';
import type { TimelineDetailRefresh, TimelineRowRemoval } from '../../engine-sql/timeline.ts';

// The chronicle reads never read these PageReadScope keys on PGLite either. `excludePrivate` is not here: the SQL
// engines apply a privacy filter for it, so it refuses.
const UNREAD_SCOPE = ['requireSafeChunks', 'minTrust', 'suppressFlagged'] as const;
// getTimelineForDate ignores `kind` and getSince ignores `week` on PGLite; the store ignores them the same way.
const CHRONICLE = ['week', 'kind', 'limit', 'sourceId', 'sourceIds'] as const;

export const getTimelineForDate: StoreMember<[date: string, opts?: ChronicleTimelineOpts], ChronicleTimelineRow[]> = (brain, date, opts) => {
  const options = takeOptions('getTimelineForDate', opts, CHRONICLE, UNREAD_SCOPE);
  return storeCall({ member: 'getTimelineForDate' }, () => brain.getTimelineForDate(date, options));
};

export const getSince: StoreMember<[date: string, opts?: ChronicleTimelineOpts], ChronicleTimelineRow[]> = (brain, date, opts) => {
  const options = takeOptions('getSince', opts, CHRONICLE, UNREAD_SCOPE);
  return storeCall({ member: 'getSince' }, () => brain.getSince(date, options));
};

export const getOnThisDay: StoreMember<[opts?: PageReadScope & { date?: string; limit?: number }], ChronicleTimelineRow[]> = (brain, opts) => {
  const options = takeOptions('getOnThisDay', opts, ['date', 'limit', 'sourceId', 'sourceIds'], UNREAD_SCOPE);
  return storeCall({ member: 'getOnThisDay' }, () => brain.getOnThisDay(options));
};

export const getLastSeen: StoreMember<[entitySlug: string, opts?: PageReadScope & { asof?: string }], LastSeenResult> = async (brain, entitySlug, opts) => {
  const options = takeOptions('getLastSeen', opts, ['asof', 'sourceId', 'sourceIds'], UNREAD_SCOPE);
  const row: { last_date: string | null; last_event_slug: string | null } =
    await storeCall({ member: 'getLastSeen', slug: entitySlug }, () => brain.getLastSeen(entitySlug, options));
  // The day count is the shared finalizer both SQL engines use.
  return finalizeLastSeen(entitySlug, row.last_date, row.last_event_slug, opts?.asof);
};

type EventProjection = { depthSlug: string; eventSlug: string; date: string; summary: string; detail?: string; sourceId?: string };

export const upsertEventProjection: StoreMember<[opts: EventProjection], { projected: boolean }> = (brain, opts) => {
  const options = takeOptions('upsertEventProjection', opts, ['depthSlug', 'eventSlug', 'date', 'summary', 'detail', 'sourceId']);
  return storeCall({ member: 'upsertEventProjection' }, () => brain.upsertEventProjection(options));
};

/** Removes the page's timeline rows a rewrite dropped; each row's date and whether a row was removed. */
export const removeTimelineRows: StoreMember<[pageId: number, rows: TimelineRowRemoval[]], Array<{ date: string; removed: boolean }>> = (brain, pageId, rows) =>
  storeCall({ member: 'removeTimelineRows' }, () => brain.removeTimelineRows(pageId, rows));

/** Refreshes the details of the page's kept timeline rows. */
export const updateTimelineDetails: StoreMember<[pageId: number, rows: TimelineDetailRefresh[]], void> = async (brain, pageId, rows) => {
  await storeCall({ member: 'updateTimelineDetails' }, () => brain.updateTimelineDetails(pageId, rows));
};
