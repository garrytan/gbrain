/**
 * Guest-note publication and the guest marks (SQL in engine-sql/guest-notes.ts), served from the guest_sources record
 * (rust/crates/gbrain-store/src/guest_sources.rs) and the guest_marks records (guest_marks.rs,
 * rust/docs/store/guest_marks.md).
 *
 * Export only BrainEngine members from this file: index.ts spreads the whole module into STORE_MEMBERS.
 */
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import type { GuestMarkInsert, GuestMarkRow } from '../../engine-sql/guest-notes.ts';
import type { GuestSourceLookupRow } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';
import { applyTransactionSettings } from './transactions.ts';

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

/** The guest marks of `pageIds`; `promoted` is false (the store keeps no guest_promotions). */
export const readGuestMarks: StoreMember<[pageIds: readonly number[]], GuestMarkRow[]> = async (brain, pageIds) =>
  pageIds.length === 0 ? [] : storeCall({ member: 'readGuestMarks' }, () => brain.readGuestMarks([...pageIds]));
