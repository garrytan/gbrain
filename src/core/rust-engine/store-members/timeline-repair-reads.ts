/**
 * The timeline repair reads and row rewrite of src/core/engine-sql/timeline-repair-reads.ts: the page scans of
 * `gbrain repair timeline`, `timeline-comments`, `timeline-order` and `connector-fences` (listTimelineHistoryPages,
 * listTimelineMarkupRows, listMaterializedMarkerPages, listDateBulletPages, listConnectorFencePages), the retraction
 * check's version reads (listTimelineVersionWitnesses, readTimelineVersionBody) and the comment-row rewrite
 * (rewriteTimelineRow). None applies a read policy, so none takes one. An id, cursor or limit the SQL engines would
 * fail to bind refuses rather than being guessed at. See rust/docs/store/timeline_queries.md.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Helpers stay unexported.
 */
import type {
  ConnectorFencePage, TimelineHistoryQuery, TimelineMarkupQuery, TimelineMarkupRow, TimelineRepairPage, TimelineRowRewrite,
  TimelineVersionBody, TimelineVersionWitness,
} from '../../engine-sql/timeline-repair-reads.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

function integer(member: string, what: string, n: number): number {
  if (!Number.isSafeInteger(n)) refuseMember(member, `${what} that is not an integer`);
  return n;
}

const page = (r: TimelineRepairPage): TimelineRepairPage =>
  ({ id: Number(r.id), source_id: r.source_id, slug: r.slug, compiled_truth: r.compiled_truth, timeline: r.timeline });

export const listTimelineHistoryPages: StoreMember<[sourceIds: readonly string[], q: TimelineHistoryQuery], TimelineRepairPage[]> =
  async (brain, sourceIds, q) => {
    const member = 'listTimelineHistoryPages';
    const input = 'ids' in q
      ? { sourceIds: [...sourceIds], ids: q.ids.map(id => integer(member, 'a page id', Number(id))) }
      : { sourceIds: [...sourceIds], afterId: integer(member, 'an afterId', q.afterId), limit: Math.max(1, Math.floor(q.limit)) };
    const rows: TimelineRepairPage[] = await storeCall({ member }, () => brain.listTimelineHistoryPages(input));
    return rows.map(page);
  };

export const listTimelineVersionWitnesses: StoreMember<[sourceId: string, slug: string], TimelineVersionWitness[]> = async (brain, sourceId, slug) => {
  const rows: TimelineVersionWitness[] = await storeCall({ member: 'listTimelineVersionWitnesses' }, () => brain.listTimelineVersionWitnesses(sourceId, slug));
  return rows.map(r => ({ id: Number(r.id), body_storage: r.body_storage, page_id: Number(r.page_id),
    generation: r.generation === null || r.generation === undefined ? null : Number(r.generation), content_hash: r.content_hash ?? null }));
};

export const readTimelineVersionBody: StoreMember<[pageId: number, versionId: number], TimelineVersionBody | null> = async (brain, pageId, versionId) => {
  const member = 'readTimelineVersionBody';
  const ids = [integer(member, 'a page id', pageId), integer(member, 'a version id', versionId)] as const;
  const body: TimelineVersionBody | null = await storeCall({ member }, () => brain.readTimelineVersionBody(...ids));
  return body ?? null;
};

export const listTimelineMarkupRows: StoreMember<[q: TimelineMarkupQuery], TimelineMarkupRow[]> = async (brain, q) => {
  const member = 'listTimelineMarkupRows';
  const input = 'pageId' in q ? { pageId: integer(member, 'a page id', q.pageId) }
    : { sourceIds: [...q.sourceIds], afterId: integer(member, 'an afterId', q.afterId) };
  const rows: TimelineMarkupRow[] = await storeCall({ member }, () => brain.listTimelineMarkupRows(input));
  return rows.map(r => ({ ...r, id: Number(r.id), page_id: Number(r.page_id) }));
};

export const listMaterializedMarkerPages: StoreMember<[sourceIds: readonly string[], afterId: number], TimelineRepairPage[]> =
  async (brain, sourceIds, afterId) => {
    const member = 'listMaterializedMarkerPages';
    const input = { sourceIds: [...sourceIds], afterId: integer(member, 'an afterId', afterId) };
    const rows: TimelineRepairPage[] = await storeCall({ member }, () => brain.listMaterializedMarkerPages(input));
    return rows.map(page);
  };

export const rewriteTimelineRow: StoreMember<[pageId: number, row: TimelineRowRewrite], void> = async (brain, pageId, row) => {
  const member = 'rewriteTimelineRow';
  const wire = { id: integer(member, 'a row id', row.id), source: row.source, summary: row.summary, detail: row.detail };
  await storeCall({ member }, () => brain.rewriteTimelineRow(integer(member, 'a page id', pageId), wire));
};

export const listDateBulletPages: StoreMember<[sourceIds: readonly string[], afterId: number, slugs: readonly string[], limit: number], TimelineRepairPage[]> =
  async (brain, sourceIds, afterId, slugs, limit) => {
    const member = 'listDateBulletPages';
    const input = { sourceIds: [...sourceIds], afterId: integer(member, 'an afterId', afterId), slugs: [...slugs], limit: Math.max(1, Math.floor(limit)) };
    const rows: TimelineRepairPage[] = await storeCall({ member }, () => brain.listDateBulletPages(input));
    return rows.map(page);
  };

export const listConnectorFencePages: StoreMember<[sourceIds: readonly string[], kinds: readonly string[], segmented: boolean], ConnectorFencePage[]> =
  async (brain, sourceIds, kinds, segmented) => {
    const input = { sourceIds: [...sourceIds], kinds: [...kinds], segmented };
    const rows: ConnectorFencePage[] = await storeCall({ member: 'listConnectorFencePages' }, () => brain.listConnectorFencePages(input));
    return rows.map(page);
  };
