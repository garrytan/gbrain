/**
 * The source reads of the CLI import path (BrainEngine listSourceRecords, readSourceIncarnation, hasCompanyBrainReceipt, readGuestSourceRow),
 * served by gbrain-store `cli_reads::import`. What the store does not keep: rust/docs/store/cli-reads-import.md.
 */
import type { GuestSourceLookupRow, SourceIncarnationRow, SourceRecordRow } from '../../engine.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

export const listSourceRecords: StoreMember<[], SourceRecordRow[]> = async (brain) => {
  const rows: SourceRecordRow[] = await storeCall({ member: 'listSourceRecords' }, () => brain.listSourceRecords());
  return rows.map(row => withDates(row, ['last_sync_at', 'created_at', 'newest_content_at']));
};

export const readSourceIncarnation: StoreMember<[sourceId: string], SourceIncarnationRow | null> = (brain, sourceId) =>
  storeCall({ member: 'readSourceIncarnation', sourceId }, () => brain.readSourceIncarnation(sourceId));

export const hasCompanyBrainReceipt: StoreMember<[sourceId: string], boolean> = (brain, sourceId) =>
  storeCall({ member: 'hasCompanyBrainReceipt', sourceId }, () => brain.hasCompanyBrainReceipt(sourceId));

export const readGuestSourceRow: StoreMember<[sourceId: string], GuestSourceLookupRow> = (brain, sourceId) =>
  storeCall({ member: 'readGuestSourceRow', sourceId }, () => brain.readGuestSourceRow(sourceId));
