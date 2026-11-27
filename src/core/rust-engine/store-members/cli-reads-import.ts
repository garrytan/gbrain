/**
 * The reads of the CLI import and extract paths (BrainEngine listSourceRecords through filterPagesAtRevision), served
 * by gbrain-store `cli_reads::import`. What the store does not keep (commit columns, ingestion receipts, guest_sources,
 * page trust) and what each member answers for it: rust/docs/store/cli-reads-import.md. readSyncDispatchRow builds the
 * sync routing row from readSourceState and hasCompanyBrainReceipt.
 */
import type {
  GuestDeleteRow, GuestSourceLookupRow, LinkPageMetadataRow, PageAtRevisionRef, PageTrustLookup, PageTrustRow, RowTrustLookup, RowTrustRow,
  SourceIncarnationRow, SourceRecordRow, StoredTimelineRow,
} from '../../engine.ts';
import type { SyncDispatchRow } from '../../engine-sql/sync-dispatch.ts';
import type { SourceStateRow } from '../../engine-sql/write-misc.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';
import { readBrainMode } from './writer-release.ts';

export const listSourceRecords: StoreMember<[], SourceRecordRow[]> = async (brain) => {
  const rows: SourceRecordRow[] = await storeCall({ member: 'listSourceRecords' }, () => brain.listSourceRecords());
  return rows.map(row => withDates(row, ['last_sync_at', 'created_at', 'newest_content_at']));
};

export const readSourceIncarnation: StoreMember<[sourceId: string], SourceIncarnationRow | null> = (brain, sourceId) =>
  storeCall({ member: 'readSourceIncarnation', sourceId }, () => brain.readSourceIncarnation(sourceId));

/**
 * The sync routing row from the store's own source reads: `claimed` is `isSourceClaimed` (a binding at the source's
 * incarnation) and `modes` is the one brain row's stored mode, as `readManagedModeRows` answers.
 */
export const readSyncDispatchRow: StoreMember<[sourceId: string], SyncDispatchRow> = async (brain, sourceId) => {
  const member = 'readSyncDispatchRow';
  const source: SourceStateRow | null = await storeCall({ member, sourceId }, () => brain.readSourceState(sourceId));
  const modes = [(await readBrainMode(brain, member)).enabled];
  if (!source) return { id: null, archived: null, config: null, incarnation: null, local_path: null, claimed: false, company_receipt: false, modes };
  const receipt: boolean = await storeCall({ member, sourceId }, () => brain.hasCompanyBrainReceipt(sourceId));
  const claimed: boolean = await storeCall({ member, sourceId }, () => brain.isSourceClaimed(sourceId));
  return {
    id: sourceId, archived: source.archived, config: source.config, incarnation: String(source.incarnation),
    local_path: source.local_path, claimed, company_receipt: receipt, modes,
  };
};

export const hasCompanyBrainReceipt: StoreMember<[sourceId: string], boolean> = (brain, sourceId) =>
  storeCall({ member: 'hasCompanyBrainReceipt', sourceId }, () => brain.hasCompanyBrainReceipt(sourceId));

export const readGuestSourceRow: StoreMember<[sourceId: string], GuestSourceLookupRow> = (brain, sourceId) =>
  storeCall({ member: 'readGuestSourceRow', sourceId }, () => brain.readGuestSourceRow(sourceId));

/**
 * A page's guest records for a remote delete. The store keeps no guest marks or promotions, and its guest_sources answer
 * is readGuestSourceRow's (no row, never hidden), so no page is a guest note the delete check refuses.
 */
export const readGuestDeleteRow: StoreMember<[sourceId: string, slug: string], GuestDeleteRow> = async (brain, sourceId) => {
  const source: GuestSourceLookupRow = await storeCall({ member: 'readGuestDeleteRow', sourceId }, () => brain.readGuestSourceRow(sourceId));
  return { hidden: source.hidden, guest: source.source_id !== null, kept: false, writer: null };
};

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

export const listLinkPageMetadataForSlugs: StoreMember<[sourceId: string, slugs: readonly string[]], LinkPageMetadataRow[]> =
  (brain, sourceId, slugs) => storeCall({ member: 'listLinkPageMetadataForSlugs', sourceId },
    () => brain.readLinkPageMetadataForSlugs(sourceId, [...slugs]));

export const listAttendedOriginSlugs: StoreMember<[sourceId: string, slugs?: readonly string[]], string[]> =
  (brain, sourceId, slugs) => storeCall({ member: 'listAttendedOriginSlugs', sourceId },
    () => brain.listAttendedOriginSlugs(sourceId, slugs ? [...slugs] : null));

export const listStoredTimelineRows: StoreMember<[sourceId: string, slug: string], StoredTimelineRow[]> = (brain, sourceId, slug) =>
  storeCall({ member: 'listStoredTimelineRows', sourceId, slug }, () => brain.listStoredTimelineRows(sourceId, slug));

export const filterPagesAtRevision: StoreMember<[refs: readonly PageAtRevisionRef[]], Array<{ slug: string; source_id: string }>> =
  async (brain, refs) =>
    refs.length === 0 ? [] : storeCall({ member: 'filterPagesAtRevision' }, () => brain.filterPagesAtRevision([...refs]));
