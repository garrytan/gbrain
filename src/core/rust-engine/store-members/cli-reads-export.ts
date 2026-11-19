/**
 * The reads `gbrain export` ran through `executeRaw` (src/commands/export.ts, src/core/export-snapshot.ts and the
 * segmented-body and folder-rule reads it reaches), served by gbrain-store `cli_reads::export`. What the store does
 * not keep (a statement timeout, fact purges, folder rules) and what each member answers for it:
 * rust/docs/store/cli-reads-export.md.
 */
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { mapStoreError } from '../store-errors.ts';
import type { ExportPageKey, ExportPageKeyQuery } from '../../engine-sql/export-reads.ts';
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
