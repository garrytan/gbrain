/**
 * The page batch of `chronicle-backfill` (engine-sql/chronicle-reads.ts) on a Rust brain, served by the store's pages
 * (rust/docs/store/chronicle-reads.md). `done` reads the store's chronicle ledger row for the page. The store
 * answers `effective_date` as ISO text; the SQL engines answer Dates. Carried from 6f801f6d17, the batch read only.
 */
import type { BrainEngine } from '../../engine.ts';
import { CHRONICLE_BACKFILL_BATCH, type ChronicleBackfillPage } from '../../engine-sql/chronicle-reads.ts';
import { storeCall, type StoreMember } from './common.ts';

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
  return rows.map(r => ({ ...r, effective_date: asDate(r.effective_date) }));
};
