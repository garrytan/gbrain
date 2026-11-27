/**
 * The source reads of the CLI import path (BrainEngine listSourceRecords, readSourceIncarnation, hasCompanyBrainReceipt, readGuestSourceRow),
 * served by gbrain-store `cli_reads::import`. What the store does not keep: rust/docs/store/cli-reads-import.md.
 */
import type { GuestSourceLookupRow, SourceIncarnationRow, SourceRecordRow } from '../../engine.ts';
import { withDates } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import type { PageTrustLookup, PageTrustRow } from '../../engine.ts';

export const listSourceRecords: StoreMember<[], SourceRecordRow[]> = async (brain) => {
  const rows: SourceRecordRow[] = await storeCall({ member: 'listSourceRecords' }, () => brain.listSourceRecords());
  return rows.map(row => withDates(row, ['last_sync_at', 'created_at', 'newest_content_at']));
};

export const readSourceIncarnation: StoreMember<[sourceId: string], SourceIncarnationRow | null> = (brain, sourceId) =>
  storeCall({ member: 'readSourceIncarnation', sourceId }, () => brain.readSourceIncarnation(sourceId));

export const hasCompanyBrainReceipt: StoreMember<[sourceId: string], boolean> = (brain, sourceId) =>
  storeCall({ member: 'hasCompanyBrainReceipt', sourceId }, () => brain.hasCompanyBrainReceipt(sourceId));

/**
 * The store keeps no guest_sources table, so it answers "not a guest" for every source. A source whose config says
 * `guest: true` is a guest source whose writer list this brain cannot hold, so the lookup refuses instead of
 * letting the guest write guards (guests/admission.ts) pass it as an ordinary source.
 */
export const readGuestSourceRow: StoreMember<[sourceId: string], GuestSourceLookupRow> = async (brain, sourceId) => {
  const guests: string[] = await storeCall({ member: 'readGuestSourceRow', sourceId }, () => brain.listGuestSourceIds([sourceId]));
  if (guests.includes(sourceId)) refuseMember('readGuestSourceRow', `source ${sourceId} is a guest source (config guest: true) and the store keeps no guest_sources row for its writers`);
  return storeCall({ member: 'readGuestSourceRow', sourceId }, () => brain.readGuestSourceRow(sourceId));
};

/** The ids among `sourceIds` that name a guest source. */
export const listGuestSourceIds: StoreMember<[sourceIds: readonly string[]], string[]> = async (brain, sourceIds) =>
  sourceIds.length === 0 ? [] : storeCall({ member: 'listGuestSourceIds' }, () => brain.listGuestSourceIds([...sourceIds]));

/** The trust rows of the pages named by id or by source and slug. */
export const readPageTrustRows: StoreMember<[lookup: PageTrustLookup], PageTrustRow[]> = (brain, lookup) =>
  storeCall({ member: 'readPageTrustRows' }, () => brain.readPageTrustRows({
    ids: [...(lookup.ids ?? [])], keys: [...(lookup.keys ?? [])], includeDeleted: lookup.includeDeleted === true,
  }));

export const hasGuestSource: StoreMember<[], boolean> = (brain) =>
  storeCall({ member: 'hasGuestSource' }, () => brain.hasGuestSource());

export const readDatabaseClock: StoreMember<[], string> = (brain) =>
  storeCall({ member: 'readDatabaseClock' }, () => brain.readDatabaseClock());
