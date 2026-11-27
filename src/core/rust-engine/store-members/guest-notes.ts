/**
 * Guest-note publication and the guest marks (SQL in engine-sql/guest-notes.ts), served from the guest_sources record
 * (rust/crates/gbrain-store/src/guest_sources.rs), the guest_marks records (guest_marks.rs, rust/docs/store/guest_marks.md)
 * and the guest_promotions records (guest_promotions.rs, rust/docs/store/guest_promotions.md).
 *
 * Export only BrainEngine members from this file: index.ts spreads the whole module into STORE_MEMBERS.
 */
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import type { GuestDeleteCheckRow, GuestMarkInsert, GuestMarkRow, GuestPromotionLink, GuestRefPageRow } from '../../engine-sql/guest-notes.ts';
import type { GuestSourceLookupRow } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';
import { applyTransactionSettings } from './transactions.ts';
import { storePagePolicy } from './private-provenance.ts';

/**
 * The source's guest record's writers, and, when it has one, `gbrain.guest_note` set to `requestId` in the store's write
 * trust settings for the rest of the transaction, as the SQL statement's `set_config` does for the matched row. The
 * store serializes its writes, so the share lock has nothing more to hold.
 */
export const claimGuestNotePublication = async function claimGuestNotePublication(this: RustEngine, brain: StoreBrain, sourceId: string, requestId: string): Promise<{ writers: string[] } | null> {
  const row: GuestSourceLookupRow = await storeCall({ member: 'claimGuestNotePublication', sourceId }, () => brain.readGuestSourceRow(sourceId));
  if (row.source_id === null) return null;
  await applyTransactionSettings.call(this, brain, ['gbrain.guest_note'], [requestId]);
  return { writers: [...(row.writers ?? [])] };
};

/** Writes the guest mark of the page at (sourceId, slug); how many rows it wrote. */
export const insertGuestMark: StoreMember<[mark: GuestMarkInsert], number> = (brain, mark) =>
  storeCall({ member: 'insertGuestMark', sourceId: mark.sourceId, slug: mark.slug }, () => brain.insertGuestMark({ ...mark }));

/** The guest marks of `pageIds`, each with whether the owner kept its page. */
export const readGuestMarks: StoreMember<[pageIds: readonly number[]], GuestMarkRow[]> = async (brain, pageIds) =>
  pageIds.length === 0 ? [] : storeCall({ member: 'readGuestMarks' }, () => brain.readGuestMarks([...pageIds]));

/** Whether the owner already kept the guest page as the page at (targetSource, targetSlug) and that page exists. */
export const readGuestPromotionKept: StoreMember<[guestPageId: number, targetSource: string, targetSlug: string], boolean> = (brain, guestPageId, targetSource, targetSlug) =>
  storeCall({ member: 'readGuestPromotionKept', sourceId: targetSource, slug: targetSlug }, () => brain.readGuestPromotionKept(guestPageId, targetSource, targetSlug));

/** Relinks or inserts the promotion link of a guest page and its target. */
export const linkGuestPromotion: StoreMember<[link: GuestPromotionLink], void> = async (brain, link) => {
  await storeCall({ member: 'linkGuestPromotion', sourceId: link.targetSource, slug: link.targetSlug }, () => brain.linkGuestPromotion({
    guestPageId: link.guestPageId, targetSource: link.targetSource, targetSlug: link.targetSlug,
    byKind: link.by.kind, byId: link.by.id, requestId: link.requestId }));
};

/** What a remote delete decides on; `hidden` is false (the store has no row-level security). */
export const readGuestDeleteCheck: StoreMember<[sourceId: string, slug: string], GuestDeleteCheckRow | null> = (brain, sourceId, slug) =>
  storeCall({ member: 'readGuestDeleteCheck', sourceId, slug }, () => brain.readGuestDeleteCheck(sourceId, slug));

/** The pages by id or key, live or soft-deleted, under the caller's page policy when `excludePrivate` (storePagePolicy). */
export const readGuestRefPages: StoreMember<[ids: readonly number[], keys: ReadonlyArray<{ source_id: string; slug: string }>, excludePrivate: boolean], GuestRefPageRow[]> =
  async (brain, ids, keys, excludePrivate) => {
    if (ids.length === 0 && keys.length === 0) return [];
    const policy = storePagePolicy('readGuestRefPages', excludePrivate, { callerReaders: true });
    return storeCall({ member: 'readGuestRefPages' }, () => brain.readGuestRefPages({
      ids: [...ids], keys: keys.map(k => ({ source_id: k.source_id, slug: k.slug })), exclude_private: policy ?? null }));
  };
