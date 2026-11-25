/**
 * The Life Chronicle event statements (src/core/engine-sql/chronicle-events.ts) on a Rust brain: the page and ledger
 * reads come from rust/crates/gbrain-store/src/generations/chronicle_events.rs, the projection rows from
 * timeline_queries/event_rows.rs.
 *
 * The store keeps the chronicle ledger's pending and skipped decisions (`chronicle_page_state`, chronicle_ledger.rs) but
 * no extracted row (the extraction writer, chronicle/execute.ts, stays raw SQL and refuses here), so it owns no event
 * hash (`listChronicleOwnedHashes` and `hasExtractedEvents` answer empty, as on a brain that never ran an extraction)
 * and reads its skip decisions from the store.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** The page at `slug` (the live one first, then the newest): its id and whether it is live, or null. */
export const readChronicleDepthRow: Member<'readChronicleDepthRow'> = async (brain, sourceId, slug) =>
  storeCall({ member: 'readChronicleDepthRow', sourceId }, () => brain.readChronicleDepthRow({ sourceId, slug }));

/** The store keeps no chronicle ledger, so it records no event hash for any depth page. */
export const listChronicleOwnedHashes: Member<'listChronicleOwnedHashes'> = async () => [];

/** The keys of `itemKeys` a generation of `kind` recorded as retired. */
export const listRetiredGenerationItemKeys: Member<'listRetiredGenerationItemKeys'> = async (brain, sourceId, kind, itemKeys) => {
  if (!itemKeys.length) return [];
  return storeCall({ member: 'listRetiredGenerationItemKeys', sourceId }, () => brain.listRetiredGenerationItemKeys({ sourceId, kind, itemKeys: [...itemKeys] }));
};

/** The projection rows of the event pages `eventPageIds`, by date. */
export const listEventProjectionRows: Member<'listEventProjectionRows'> = async (brain, eventPageIds) => {
  if (!eventPageIds.length) return [];
  return storeCall({ member: 'listEventProjectionRows' }, () => brain.listEventProjectionRows({ eventPageIds: [...eventPageIds] }));
};

/** The content hash of each page the query selects. */
export const listPageContentHashes: Member<'listPageContentHashes'> = async (brain, query) => {
  if (!(query.match === 'ids' ? query.ids : query.slugs).length) return [];
  return storeCall({ member: 'listPageContentHashes', sourceId: query.sourceId }, () => brain.listPageContentHashes(
    query.match === 'ids' ? { sourceId: query.sourceId, match: 'ids', ids: [...query.ids] } : { sourceId: query.sourceId, match: 'live_slugs', slugs: [...query.slugs] }));
};

/** The items the live generation of `key` holds without retiring them. */
export const listLiveGenerationItems: Member<'listLiveGenerationItems'> = async (brain, key) =>
  storeCall({ member: 'listLiveGenerationItems', sourceId: key.sourceId }, () => brain.listLiveGenerationItems({ sourceId: key.sourceId, kind: key.kind, ownerKey: key.ownerKey }));

/** The id of the projection row of `eventPageId` on `date`, or null. */
export const readEventProjectionId: Member<'readEventProjectionId'> = async (brain, eventPageId, date) =>
  storeCall({ member: 'readEventProjectionId' }, () => brain.readEventProjectionId({ eventPageId, date }));

/** Whether a page row (a soft-deleted one included) has `slug`. */
export const pageSlugExists: Member<'pageSlugExists'> = async (brain, sourceId, slug) =>
  storeCall({ member: 'pageSlugExists', sourceId }, () => brain.pageSlugExists({ sourceId, slug }));

/** Deletes the projection rows of the event pages at `slugs`. */
export const deleteEventProjections: Member<'deleteEventProjections'> = async (brain, sourceId, slugs) => {
  if (!slugs.length) return;
  await storeCall({ member: 'deleteEventProjections', sourceId }, () => brain.deleteEventProjections({ sourceId, slugs: [...slugs] }));
};

/** Puts one projection row of a restored event page back on its depth page. */
export const restoreEventProjection: Member<'restoreEventProjection'> = async (brain, row) => {
  await storeCall({ member: 'restoreEventProjection' }, () => brain.restoreEventProjection({
    depthPageId: row.depthPageId, date: row.date, source: row.source, summary: row.summary, detail: row.detail ?? null, eventPageId: row.eventPageId }));
};

/** Whether the store's ledger records that skip decision for that page revision. */
export const hasChronicleSkipDecision: Member<'hasChronicleSkipDecision'> = async (brain, d) =>
  storeCall({ member: 'hasChronicleSkipDecision', sourceId: d.sourceId }, () =>
    brain.hasChronicleSkipDecision(d.sourceId, d.pageId, d.contentHash, d.extractorVersion, d.reason)) as Promise<boolean>;

/** The live generations of `kind` whose depth page is gone and that still hold a live item, oldest update first. */
export const listOrphanedChronicleOwners: Member<'listOrphanedChronicleOwners'> = async (brain, sourceId, kind, limit) =>
  storeCall({ member: 'listOrphanedChronicleOwners', sourceId }, () => brain.listOrphanedChronicleOwners({ sourceId, kind, limit }));

/** The chronicle advisor's coverage-gap rows; the store answers `effective_date` as ISO text, read here as a Date. */
export const listChronicleCoverageGapRows: Member<'listChronicleCoverageGapRows'> = async (brain) => {
  const rows = await storeCall({ member: 'listChronicleCoverageGapRows' }, () => brain.listChronicleCoverageGapRows()) as Array<{
    type: string; effective_date: string | null; effective_date_source: string | null; fm_date: string | null; fm_start: string | null }>;
  return rows.map(r => ({ ...r, effective_date: r.effective_date == null ? null : new Date(r.effective_date) }));
};

/** The `frontmatter.event` when, where and kind of each page of `slugs`. */
export const listChronicleEventSlotRows: Member<'listChronicleEventSlotRows'> = async (brain, sourceId, slugs) => {
  if (!slugs.length) return [];
  return storeCall({ member: 'listChronicleEventSlotRows', sourceId }, () => brain.listChronicleEventSlotRows({ sourceId, slugs: [...slugs] }));
};
