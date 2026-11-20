/**
 * The guest source rows and the notes in them (SQL in engine-sql/collate-guest-sources.ts), served from the guest row
 * records (rust/crates/gbrain-store/src/guest_sources.rs, rust/docs/store/guest_sources.md).
 */
import type { GuestSourceRow } from '../../engine-sql/collate-guest-sources.ts';
import { storeCall, type StoreMember } from './common.ts';

/** Writes the source's guest row, or merges `writers` into the row it has (distinct, in byte order; its ceiling stays). */
export const upsertGuestSource: StoreMember<[sourceId: string, writers: readonly string[], trustCeiling: string], GuestSourceRow> = (brain, sourceId, writers, trustCeiling) =>
  storeCall({ member: 'upsertGuestSource', sourceId }, () => brain.upsertGuestSource(sourceId, [...writers], trustCeiling));

/** The live page at `slug` in each guest source (only `guestSource` when given), by source id in byte order. */
export const listGuestNotes: StoreMember<[slug: string, guestSource?: string], Array<{ id: number; source_id: string }>> = (brain, slug, guestSource) =>
  storeCall({ member: 'listGuestNotes' }, () => brain.listGuestNotes(slug, guestSource ?? null));
