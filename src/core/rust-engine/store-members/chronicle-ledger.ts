/**
 * The write-time chronicle ledger members of engine-sql/chronicle-ledger.ts, served by the store's chronicle rows
 * (rust/docs/store/chronicle-ledger.md and rust/docs/store/telemetry.md), plus the config insert and the truth-lead
 * read the same decision makes.
 */
import type { BrainEngine } from '../../engine.ts';
import type { ChronicleLedgerRow } from '../../chronicle/contract.ts';
import { storeCall, type StoreMember } from './common.ts';
import { mapStoreError, storeErrorCode } from '../store-errors.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** The foreign key of `chronicle_page_state` each store refusal stands for; a row missing both names the source's. */
const FOREIGN_KEY_OF: Record<string, string> = {
  source_not_found: 'chronicle_page_state_source_id_fkey',
  page_not_found: 'chronicle_page_state_page_id_fkey',
};
/** SQLSTATE `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * The checked store call: the SQL engines' foreign keys refuse a row whose source or page is missing, and the store
 * refuses the same (`source_not_found` / `page_not_found`) and writes nothing. The refusal is thrown as the SQL
 * engines throw it: code `23503` and the foreign-key violation's message, so a caller (and an agent reading the
 * message) sees the same error on every engine.
 */
export const upsertChronicleRow: Member<'upsertChronicleRow'> = async (brain, w) => {
  try {
    return await brain.upsertChronicleRowChecked(w) as Awaited<ReturnType<BrainEngine['upsertChronicleRow']>>;
  } catch (error) {
    const constraint = FOREIGN_KEY_OF[storeErrorCode(error) ?? ''];
    if (constraint) {
      throw Object.assign(new Error(`insert or update on table "chronicle_page_state" violates foreign key constraint "${constraint}"`),
        { code: FOREIGN_KEY_VIOLATION });
    }
    throw mapStoreError(error, { member: 'upsertChronicleRow' });
  }
};

/** The store answers `decided_at` and `updated_at` as ISO text; the SQL engines answer Dates. */
export const readChronicleRow: Member<'readChronicleRow'> = async (brain, key) => {
  const row = await storeCall({ member: 'readChronicleRow', sourceId: key.sourceId }, () => brain.readChronicleRow(key)) as
    (Omit<ChronicleLedgerRow, 'decided_at' | 'updated_at'> & { decided_at: string; updated_at: string }) | null;
  if (!row) return null;
  return {
    ...row,
    next_attempt_at: row.next_attempt_at == null ? null : new Date(row.next_attempt_at),
    decided_at: new Date(row.decided_at),
    updated_at: new Date(row.updated_at),
  } as ChronicleLedgerRow;
};

export const hasPendingAutoChronicleRow: Member<'hasPendingAutoChronicleRow'> = (brain, sourceId, pageId, extractorVersion) =>
  storeCall({ member: 'hasPendingAutoChronicleRow', sourceId }, () => brain.hasPendingAutoChronicleRow(sourceId, pageId, extractorVersion));

export const countRecentChronicleReservations: Member<'countRecentChronicleReservations'> = (brain) =>
  storeCall({ member: 'countRecentChronicleReservations' }, () => brain.countRecentChronicleReservations());

export const insertConfigIfAbsent: Member<'insertConfigIfAbsent'> = async (brain, key, value) => {
  await storeCall({ member: 'insertConfigIfAbsent' }, () => brain.insertConfigIfAbsent(key, value));
};

export const readPageTruthLead: Member<'readPageTruthLead'> = (brain, pageId) =>
  storeCall({ member: 'readPageTruthLead' }, () => brain.readPageTruthLead(pageId));
