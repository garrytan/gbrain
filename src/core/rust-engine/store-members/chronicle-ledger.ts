/**
 * The write-time chronicle ledger members of engine-sql/chronicle-ledger.ts, served by the store's chronicle rows
 * (rust/docs/store/chronicle-ledger.md and rust/docs/store/telemetry.md), plus the config insert and the truth-lead
 * read the same decision makes.
 */
import type { BrainEngine } from '../../engine.ts';
import type { ChronicleLedgerRow } from '../../chronicle/contract.ts';
import { storeCall, type StoreMember } from './common.ts';
import type { ChronicleStore } from '../../engine-sql/chronicle-executor.ts';
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

/** The store's write transaction serializes the reserve, as the advisory lock does on the SQL engines. */
export const reserveChronicleJudgeSlot: Member<'reserveChronicleJudgeSlot'> = (brain, limit, key) =>
  storeCall({ member: 'reserveChronicleJudgeSlot', sourceId: key.sourceId }, () => brain.reserveChronicleJudgeSlot(limit, key));

export const pruneChronicleReservations: Member<'pruneChronicleReservations'> = async (brain) => {
  await storeCall({ member: 'pruneChronicleReservations' }, () => brain.pruneChronicleReservations());
};

export const insertConfigIfAbsent: Member<'insertConfigIfAbsent'> = async (brain, key, value) => {
  await storeCall({ member: 'insertConfigIfAbsent' }, () => brain.insertConfigIfAbsent(key, value));
};

export const readPageTruthLead: Member<'readPageTruthLead'> = (brain, pageId) =>
  storeCall({ member: 'readPageTruthLead' }, () => brain.readPageTruthLead(pageId));

/** A store row of `chronicle_page_state` with the times the SQL engines answer as Dates. */
function ledgerRow(row: Record<string, unknown>): ChronicleLedgerRow {
  return {
    ...row,
    next_attempt_at: row.next_attempt_at == null ? null : new Date(String(row.next_attempt_at)),
    decided_at: new Date(String(row.decided_at)),
    updated_at: new Date(String(row.updated_at)),
  } as unknown as ChronicleLedgerRow;
}

/**
 * The chronicle executor's statements (engine-sql/chronicle-executor.ts), each answered by the store's chronicle rows,
 * pages and timeline (rust/docs/store/chronicle-ledger.md, "Executor"). A statement whose SQL answers no row answers
 * `undefined` here too, and the times the SQL engines answer as Dates are Dates.
 */
export const chronicleStore: Member<'chronicleStore'> = async (brain) => {
  const call = <T>(op: string, ...args: unknown[]) =>
    storeCall({ member: 'chronicleStore' }, () => brain.chronicleExecutor(op, args)) as Promise<T>;
  const opt = <T>(value: T | null) => value ?? undefined;
  const store: ChronicleStore = {
    queueCampaignRow: (q) => call('queueCampaignRow', q),
    campaignSpentUsd: async (campaignId) => opt(await call<{ usd: number } | null>('campaignSpentUsd', campaignId)),
    failExhaustedCampaignRows: async (defaultMaxAttempts) => { await call('failExhaustedCampaignRows', defaultMaxAttempts); },
    discoveryPages: async (sourceId, activatedAt, types, slugPatterns, extractorVersion, limit) =>
      (await call<Array<Record<string, unknown>>>('discoveryPages', { sourceId, activatedAt, types, slugPatterns, extractorVersion, limit }))
        .map(page => ({ ...page, effective_date: page.effective_date == null ? null : new Date(String(page.effective_date)),
          updated_at: new Date(String(page.updated_at)) })) as never,
    candidates: async (sourceId, extractorVersion, enabled, defaultMaxAttempts, retireReasons, limit) =>
      (await call<Array<Record<string, unknown>>>('candidates', { sourceId, extractorVersion, enabled, defaultMaxAttempts, retireReasons, limit }))
        .map(ledgerRow),
    supersedeStaleRows: async () => { await call('supersedeStaleRows'); },
    claim: async (key, leaseMs, state, defaultMaxAttempts) => {
      const row = await call<Record<string, unknown> | null>('claim', key, leaseMs, state, defaultMaxAttempts);
      return row ? ledgerRow(row) : null;
    },
    setNextAttempt: async (key, at) => { await call('setNextAttempt', key, at); },
    addAttemptCost: async (key, costUsd, attempt) => { await call('addAttemptCost', key, costUsd, attempt); },
    finish: async (key, f) => { await call('finish', key, f); },
    latestJudged: async (...args) => opt(await call('latestJudged', ...args)),
    inputFailures: async (...args) => opt(await call('inputFailures', ...args)),
    liveEventSlugs: (...args) => call('liveEventSlugs', ...args),
    eventProducers: (...args) => call('eventProducers', ...args),
    addAttempt: (key) => call('addAttempt', key),
    liveEventHashes: (...args) => call('liveEventHashes', ...args),
    livePageId: async (...args) => opt(await call('livePageId', ...args)),
    deleteEventTimeline: async (...args) => { await call('deleteEventTimeline', ...args); },
    eventTimelineEntry: async (...args) => opt(await call('eventTimelineEntry', ...args)),
    eventDiscriminators: (...args) => call('eventDiscriminators', ...args),
  };
  return store;
};
