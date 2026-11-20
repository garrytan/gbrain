/**
 * The cycle window reads (BrainEngine readCycleListingInstant, listSourceChangedPagesAfter; SQL in
 * engine-sql/collate-cycle-window.ts), served from the page records (rust/crates/gbrain-store/src/cycle_window.rs).
 * What each member answers: rust/docs/store/collate-cycle-window.md.
 */
import type { SourceChangedPageRow } from '../../engine-sql/collate-cycle-window.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readCycleListingInstant: StoreMember<[], string | null> = async (brain) =>
  await storeCall({ member: 'readCycleListingInstant' }, () => brain.readCycleListingInstant()) as string | null;

export const listSourceChangedPagesAfter: StoreMember<[sourceId: string, since: string | null, slug: string, limit: number], SourceChangedPageRow[]> = async (brain, sourceId, since, slug, limit) =>
  await storeCall({ member: 'listSourceChangedPagesAfter', sourceId }, () => brain.listSourceChangedPagesAfter(sourceId, since, slug, limit)) as SourceChangedPageRow[];
