/**
 * Timeline reads by date: the Life Chronicle reads (BrainEngine getTimelineForDate, getSince, getOnThisDay,
 * getLastSeen), the event projection write (upsertEventProjection), the three page-write row members
 * (removeTimelineRows, updateTimelineDetails, insertPageTimelineRows), and the timeline reads and delete of
 * src/core/engine-sql/timeline-reads.ts (sampleEffectiveDates, sampleEffectiveDateSources, readMaxTimelineEntryId,
 * listStoredTimelineRowsOrdered, deleteTimelineRows, storedTimelineRowsByPageIds, countSegmentedTimelinePages,
 * countTimelineCommentMarkupRows, listTimelineOrphanPages). The chronicle reads take the page privacy policy of
 * `excludePrivate` (storePagePolicy): a row drops when the policy hides its depth page or its event page. The other
 * statements apply no read policy, so their members take none. A value the SQL engines would fail to bind (an id or
 * limit that is not an integer, a negative limit) refuses rather than being guessed at. See
 * rust/docs/store/timeline_queries.md.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 */
import { finalizeLastSeen } from '../../chronicle/last-seen.ts';
import type { TimelineDetailRefresh, TimelineRowInsert, TimelineRowRemoval } from '../../engine-sql/timeline.ts';
import type { ChronicleTimelineOpts, ChronicleTimelineRow, LastSeenResult, PageReadScope } from '../../types.ts';
import type {
  EffectiveDateFallbackRow, EffectiveDateSampleCounts, OwnTimelineRow, PageTimelineRow, SegmentedTimelinePages, TimelineOrphanPage,
  TimelineRowDeletion,
} from '../../engine-sql/timeline-reads.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

// The chronicle reads never read these PageReadScope keys on PGLite either (a remote caller's readPolicyOpts sends
// requireSafeChunks and takesHoldersAllowList). `excludePrivate` is served: the store applies the page policy to the
// depth page and the event page of each row.
const UNREAD_SCOPE = ['requireSafeChunks', 'minTrust', 'suppressFlagged', 'takesHoldersAllowList'] as const;
// getTimelineForDate ignores `kind` and getSince ignores `week` on PGLite; the store ignores them the same way.
const CHRONICLE = ['week', 'kind', 'limit', 'sourceId', 'sourceIds', 'excludePrivate'] as const;

/** The options with `excludePrivate` replaced by the page policy the store applies, or null for none. */
function withPolicy(member: string, options: Record<string, unknown>): Record<string, unknown> {
  return { ...options, excludePrivate: storePagePolicy(member, options.excludePrivate, { callerReaders: true }) ?? null };
}

export const getTimelineForDate: StoreMember<[date: string, opts?: ChronicleTimelineOpts], ChronicleTimelineRow[]> = (brain, date, opts) => {
  const options = withPolicy('getTimelineForDate', takeOptions('getTimelineForDate', opts, CHRONICLE, UNREAD_SCOPE));
  return storeCall({ member: 'getTimelineForDate' }, () => brain.getTimelineForDate(date, options));
};

export const getSince: StoreMember<[date: string, opts?: ChronicleTimelineOpts], ChronicleTimelineRow[]> = (brain, date, opts) => {
  const options = withPolicy('getSince', takeOptions('getSince', opts, CHRONICLE, UNREAD_SCOPE));
  return storeCall({ member: 'getSince' }, () => brain.getSince(date, options));
};

export const getOnThisDay: StoreMember<[opts?: PageReadScope & { date?: string; limit?: number }], ChronicleTimelineRow[]> = (brain, opts) => {
  const options = withPolicy('getOnThisDay',
    takeOptions('getOnThisDay', opts, ['date', 'limit', 'sourceId', 'sourceIds', 'excludePrivate'], UNREAD_SCOPE));
  return storeCall({ member: 'getOnThisDay' }, () => brain.getOnThisDay(options));
};

export const getLastSeen: StoreMember<[entitySlug: string, opts?: PageReadScope & { asof?: string }], LastSeenResult> = async (brain, entitySlug, opts) => {
  const options = withPolicy('getLastSeen', takeOptions('getLastSeen', opts, ['asof', 'sourceId', 'sourceIds', 'excludePrivate'], UNREAD_SCOPE));
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

export const removeTimelineRows: StoreMember<[pageId: number, rows: TimelineRowRemoval[]], Array<{ date: string; removed: boolean }>> = (brain, pageId, rows) =>
  storeCall({ member: 'removeTimelineRows' }, () => brain.removeTimelineRows(pageId, rows));

export const updateTimelineDetails: StoreMember<[pageId: number, rows: TimelineDetailRefresh[]], void> = async (brain, pageId, rows) => {
  await storeCall({ member: 'updateTimelineDetails' }, () => brain.updateTimelineDetails(pageId, rows));
};

export const insertPageTimelineRows: StoreMember<[pageId: number, rows: TimelineRowInsert[]], void> = async (brain, pageId, rows) => {
  await storeCall({ member: 'insertPageTimelineRows' }, () => brain.insertPageTimelineRows(pageId, rows));
};

// ---------------------------------------------------------------------------------------------------------------------
// The timeline reads of src/core/engine-sql/timeline-reads.ts
// ---------------------------------------------------------------------------------------------------------------------

const INT32_MAX = 2 ** 31 - 1;

/** A value the SQL engines bind as an `integer`: one that is not an int4 is refused rather than guessed at. */
function int32(member: string, id: number): number {
  if (!Number.isInteger(id) || Math.abs(id) > INT32_MAX) refuseMember(member, 'an id that is not a 32-bit integer');
  return id;
}

/** A value the SQL engines bind as a `bigint`. */
function bigint(member: string, what: string, n: number): number {
  if (!Number.isSafeInteger(n)) refuseMember(member, `${what} that is not an integer`);
  return n;
}

/** A `LIMIT` value: Postgres refuses a negative one. */
function limitOf(member: string, limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) refuseMember(member, 'a limit that is not a non-negative integer');
  return limit;
}

const ownRow = (r: OwnTimelineRow): OwnTimelineRow =>
  ({ id: Number(r.id), date: r.date, source: r.source, summary: r.summary, detail: r.detail });

export const sampleEffectiveDates: StoreMember<[], EffectiveDateSampleCounts> = async (brain) => {
  const r: EffectiveDateSampleCounts = await storeCall({ member: 'sampleEffectiveDates' }, () => brain.sampleEffectiveDates());
  return { future_dated: Number(r.future_dated), pre_1990: Number(r.pre_1990) };
};

export const sampleEffectiveDateSources: StoreMember<[], EffectiveDateFallbackRow[]> = async (brain) => {
  const rows: Array<{ slug: string; frontmatter: unknown; created_at: string; updated_at: string }> =
    await storeCall({ member: 'sampleEffectiveDateSources' }, () => brain.sampleEffectiveDateSources());
  return rows.map(r => ({ slug: r.slug, frontmatter: r.frontmatter, created_at: new Date(r.created_at), updated_at: new Date(r.updated_at) }));
};

export const readMaxTimelineEntryId: StoreMember<[], number> =
  async (brain) => Number(await storeCall({ member: 'readMaxTimelineEntryId' }, () => brain.readMaxTimelineEntryId()));

export const listStoredTimelineRowsOrdered: StoreMember<[pageId: number], OwnTimelineRow[]> = async (brain, pageId) => {
  const id = int32('listStoredTimelineRowsOrdered', pageId);
  const rows: OwnTimelineRow[] = await storeCall({ member: 'listStoredTimelineRowsOrdered' }, () => brain.listStoredTimelineRowsOrdered(id));
  return rows.map(ownRow);
};

export const deleteTimelineRows: StoreMember<[pageId: number, deletions: readonly TimelineRowDeletion[]], Array<{ date: string; removed: boolean }>> =
  (brain, pageId, deletions) => {
    const member = 'deleteTimelineRows';
    const id = int32(member, pageId);
    // The JSON document the SQL engines send: JSON.stringify drops an undefined field, which reads as NULL.
    const wire = deletions.map(d => {
      if (d.id !== undefined && d.id !== null) int32(member, d.id);
      return JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
    });
    return storeCall({ member }, () => brain.deleteTimelineRows({ pageId: id, deletions: wire }));
  };

export const storedTimelineRowsByPageIds: StoreMember<[pageIds: readonly number[]], PageTimelineRow[]> = async (brain, pageIds) => {
  const member = 'storedTimelineRowsByPageIds';
  if (!pageIds.length) return [];
  const ids = pageIds.map(id => bigint(member, 'a page id', id));
  const rows: PageTimelineRow[] = await storeCall({ member }, () => brain.storedTimelineRowsByPageIds(ids));
  return rows.map(r => ({ page_id: Number(r.page_id), ...ownRow(r) }));
};

export const countSegmentedTimelinePages: StoreMember<[sourceIds: readonly string[], limit: number], SegmentedTimelinePages> =
  async (brain, sourceIds, limit) => {
    const member = 'countSegmentedTimelinePages';
    const input = { sourceIds: [...sourceIds], limit: limitOf(member, limit) };
    const r: SegmentedTimelinePages = await storeCall({ member }, () => brain.countSegmentedTimelinePages(input));
    return { pages: Number(r.pages), rows: Number(r.rows), sample: r.sample.map(p => ({ source_id: p.source_id, slug: p.slug })) };
  };

export const countTimelineCommentMarkupRows: StoreMember<[sourceIds: readonly string[]], number> = async (brain, sourceIds) =>
  Number(await storeCall({ member: 'countTimelineCommentMarkupRows' }, () => brain.countTimelineCommentMarkupRows([...sourceIds])));

export const listTimelineOrphanPages: StoreMember<[opts: { afterId: number; limit: number; sourceId?: string }], TimelineOrphanPage[]> =
  async (brain, opts) => {
    const member = 'listTimelineOrphanPages';
    const o = takeOptions(member, opts, ['afterId', 'limit', 'sourceId']) as { afterId: number; limit: number; sourceId?: string };
    const input = { afterId: bigint(member, 'an afterId', o.afterId), limit: limitOf(member, o.limit), sourceId: o.sourceId || null };
    const rows: TimelineOrphanPage[] = await storeCall({ member }, () => brain.listTimelineOrphanPages(input));
    return rows.map(r => ({ ...r, id: Number(r.id) }));
  };
