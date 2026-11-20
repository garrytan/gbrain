/**
 * The write-time chronicle ledger members of engine-sql/chronicle-ledger.ts, served by the store's chronicle rows
 * (rust/docs/store/chronicle-ledger.md and rust/docs/store/telemetry.md), plus the config insert and the truth-lead
 * read the same decision makes.
 */
import type { BrainEngine } from '../../engine.ts';
import type { ChronicleLedgerRow } from '../../chronicle/contract.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const upsertChronicleRow: Member<'upsertChronicleRow'> = (brain, w) =>
  storeCall({ member: 'upsertChronicleRow' }, () => brain.upsertChronicleRow(w)) as Promise<Awaited<ReturnType<BrainEngine['upsertChronicleRow']>>>;

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
