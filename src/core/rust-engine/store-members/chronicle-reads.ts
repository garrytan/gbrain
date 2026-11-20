/**
 * The chronicle backfill batch, the campaign queue and spend, and the advisor's coverage-gap scan of
 * engine-sql/chronicle-reads.ts, served by the store's chronicle rows and pages (rust/docs/store/chronicle-reads.md).
 * The store answers `effective_date` as ISO text; the SQL engines answer Dates.
 */
import type { BrainEngine } from '../../engine.ts';
import { CHRONICLE_BACKFILL_BATCH, type ChronicleBackfillPage, type ChronicleCoverageGapPage } from '../../engine-sql/chronicle-reads.ts';
import { storeCall, type StoreMember } from './common.ts';
import { mapStoreError, storeErrorCode } from '../store-errors.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const asDate = (iso: string | null): Date | null => (iso == null ? null : new Date(iso));

export const readChronicleBackfillBatch: Member<'readChronicleBackfillBatch'> = async (brain, q) => {
  // The scope the SQL text picks: the source list when it has any, else one source, else every source.
  const query = {
    types: q.types, slugPatterns: q.slugPatterns, extractorVersion: q.extractorVersion,
    sourceIds: q.sourceIds?.length ? q.sourceIds : null, sourceId: !q.sourceIds?.length && q.sourceId ? q.sourceId : null,
    since: q.since ? q.since : null, afterId: q.afterId,
    pageBatch: CHRONICLE_BACKFILL_BATCH.pageBatch, maxAttempts: CHRONICLE_BACKFILL_BATCH.maxAttempts,
  };
  const rows = await storeCall({ member: 'readChronicleBackfillBatch' }, () => brain.readChronicleBackfillBatch(query)) as
    Array<Omit<ChronicleBackfillPage, 'effective_date'> & { effective_date: string | null }>;
  return rows.map((r) => ({ ...r, effective_date: asDate(r.effective_date) }));
};

/** The foreign key of `chronicle_page_state` each store refusal stands for, as upsertChronicleRow maps them. */
const FOREIGN_KEY_OF: Record<string, string> = {
  source_not_found: 'chronicle_page_state_source_id_fkey',
  page_not_found: 'chronicle_page_state_page_id_fkey',
};

/**
 * The two amounts cross as the text the SQL engines bind to `::numeric`. A missing source or page is refused by the
 * store and thrown as the SQL engines throw it: code `23503` and the foreign-key violation's message.
 */
export const queueChronicleCampaignRow: Member<'queueChronicleCampaignRow'> = async (brain, w) => {
  try {
    return await brain.queueChronicleCampaignRow({ ...w, attemptCapUsd: String(w.attemptCapUsd), maxUsd: String(w.maxUsd) }) as boolean;
  } catch (error) {
    const constraint = FOREIGN_KEY_OF[storeErrorCode(error) ?? ''];
    if (constraint) {
      throw Object.assign(new Error(`insert or update on table "chronicle_page_state" violates foreign key constraint "${constraint}"`),
        { code: '23503' });
    }
    throw mapStoreError(error, { member: 'queueChronicleCampaignRow', sourceId: w.sourceId });
  }
};

export const readChronicleCampaignSpentUsd: Member<'readChronicleCampaignSpentUsd'> = (brain, campaignId) =>
  storeCall({ member: 'readChronicleCampaignSpentUsd' }, () => brain.readChronicleCampaignSpentUsd(campaignId));

export const listChronicleCoverageGapPages: Member<'listChronicleCoverageGapPages'> = async (brain) => {
  const rows = await storeCall({ member: 'listChronicleCoverageGapPages' }, () => brain.listChronicleCoverageGapPages()) as
    Array<Omit<ChronicleCoverageGapPage, 'effective_date'> & { effective_date: string | null }>;
  return rows.map((r) => ({ ...r, effective_date: asDate(r.effective_date) }));
};
