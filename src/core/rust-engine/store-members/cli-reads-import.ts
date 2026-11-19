/**
 * The reads of the CLI import and extract paths (BrainEngine listSourceRecords through filterPagesAtRevision), served
 * by gbrain-store `cli_reads::import`. What the store does not keep (commit columns, ingestion receipts, guest_sources,
 * page trust) and what each member answers for it: rust/docs/store/cli-reads-import.md.
 */
import type {
  GuestSourceLookupRow, LinkPageMetadataRow, PageAtRevisionRef, PageTrustLookup, PageTrustRow, RowTrustLookup, RowTrustRow,
  SourceIncarnationRow, SourceRecordRow, StoredTimelineRow,
} from '../../engine.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

export const listSourceRecords: StoreMember<[], SourceRecordRow[]> = async (brain) => {
  const rows: SourceRecordRow[] = await storeCall({ member: 'listSourceRecords' }, () => brain.listSourceRecords());
  return rows.map(row => withDates(row, ['last_sync_at', 'created_at']));
};

export const readSourceIncarnation: StoreMember<[sourceId: string], SourceIncarnationRow | null> = (brain, sourceId) =>
  storeCall({ member: 'readSourceIncarnation', sourceId }, () => brain.readSourceIncarnation(sourceId));

export const hasCompanyBrainReceipt: StoreMember<[sourceId: string], boolean> = (brain, sourceId) =>
  storeCall({ member: 'hasCompanyBrainReceipt', sourceId }, () => brain.hasCompanyBrainReceipt(sourceId));

export const readGuestSourceRow: StoreMember<[sourceId: string], GuestSourceLookupRow> = (brain, sourceId) =>
  storeCall({ member: 'readGuestSourceRow', sourceId }, () => brain.readGuestSourceRow(sourceId));

export const listGuestSourceIds: StoreMember<[sourceIds: readonly string[]], string[]> = async (brain, sourceIds) =>
  sourceIds.length === 0 ? [] : storeCall({ member: 'listGuestSourceIds' }, () => brain.listGuestSourceIds([...sourceIds]));

export const hasGuestSource: StoreMember<[], boolean> = (brain) =>
  storeCall({ member: 'hasGuestSource' }, () => brain.hasGuestSource());

export const readPageTrustRows: StoreMember<[lookup: PageTrustLookup], PageTrustRow[]> = (brain, lookup) =>
  storeCall({ member: 'readPageTrustRows' }, () => brain.readPageTrustRows({
    ids: [...(lookup.ids ?? [])], keys: [...(lookup.keys ?? [])], includeDeleted: lookup.includeDeleted === true,
  }));

/** Timeline, fact and take rows read the tier, origin, activation flag and contested reference their writes stamped. */
export const readRowTrustRows: StoreMember<[lookup: RowTrustLookup], RowTrustRow[]> = (brain, lookup) =>
  storeCall({ member: 'readRowTrustRows' }, () => brain.readRowTrustRows({ table: lookup.table, ids: [...lookup.ids] }));

export const readDatabaseClock: StoreMember<[], string> = (brain) =>
  storeCall({ member: 'readDatabaseClock' }, () => brain.readDatabaseClock());

export const listLinkPageMetadata: StoreMember<[sourceId?: string], LinkPageMetadataRow[]> = (brain, sourceId) =>
  storeCall({ member: 'listLinkPageMetadata', sourceId }, () => brain.listLinkPageMetadata(sourceId));

export const listStoredTimelineRows: StoreMember<[sourceId: string, slug: string], StoredTimelineRow[]> = (brain, sourceId, slug) =>
  storeCall({ member: 'listStoredTimelineRows', sourceId, slug }, () => brain.listStoredTimelineRows(sourceId, slug));

export const filterPagesAtRevision: StoreMember<[refs: readonly PageAtRevisionRef[]], Array<{ slug: string; source_id: string }>> =
  async (brain, refs) =>
    refs.length === 0 ? [] : storeCall({ member: 'filterPagesAtRevision' }, () => brain.filterPagesAtRevision([...refs]));
