/**
 * The reads `gbrain export` ran through `executeRaw` (src/commands/export.ts, src/core/export-snapshot.ts and the
 * segmented-body and folder-rule reads it reaches), served by gbrain-store `cli_reads::export`. What the store does
 * not keep (a statement timeout, fact purges, folder rules) and what each member answers for it:
 * rust/docs/store/cli-reads-export.md.
 */
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { mapStoreError } from '../store-errors.ts';
import type { ExportPageKey, ExportPageKeyQuery, ExportWithdrawalRow } from '../../engine-sql/export-reads.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

/**
 * `SET LOCAL statement_timeout`: the store has no statement timeout, so this does nothing. Refuses on a transaction
 * that has ended, as the other transaction members do.
 */
export const setLocalStatementTimeout = async function setLocalStatementTimeout(this: RustEngine, _brain: StoreBrain, ms: number): Promise<void> {
  if (this._txScope?.ended) throw mapStoreError({ code: 'store_closed' }, { member: 'setLocalStatementTimeout' });
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error(`setLocalStatementTimeout: ms must be a non-negative integer, got ${ms}`);
};

/** The next 256 live pages after `q.afterId`, in id order (`cli_reads::export::list_export_page_keys`). */
export const listExportPageKeys: StoreMember<[q: ExportPageKeyQuery], ExportPageKey[]> = (brain, q) =>
  storeCall({ member: 'listExportPageKeys' }, () => brain.listExportPageKeys(q));

/** The withdrawal ledger's size in bytes (`cli_reads::export::read_export_withdrawal_ledger_bytes`). */
export const readExportWithdrawalLedgerBytes: StoreMember<[sourceId: string], number> = (brain, sourceId) =>
  storeCall({ member: 'readExportWithdrawalLedgerBytes', sourceId }, () => brain.readExportWithdrawalLedgerBytes(sourceId));

/**
 * The source's withdrawals by visibility, fact hash and subject (`cli_reads::export::list_export_withdrawals`). The store
 * keeps no purge tombstones, so every row has `purged` false. `withdrawn_at` comes back a Date, as on PGLite.
 */
export const listExportWithdrawals: StoreMember<[sourceId: string], ExportWithdrawalRow[]> = async (brain, sourceId) => {
  const rows: ExportWithdrawalRow[] = await storeCall({ member: 'listExportWithdrawals', sourceId }, () => brain.listExportWithdrawals(sourceId));
  return rows.map(row => withDates(row, ['withdrawn_at']));
};
