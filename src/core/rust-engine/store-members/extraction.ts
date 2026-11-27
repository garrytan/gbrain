/**
 * Extraction members (BrainEngine countStalePagesForExtraction, listStalePagesForExtraction, readExtractionLagCounts,
 * markPagesExtractedBatch, markPagesAttendanceBlocked, countStaleFrontmatterKeyPages, listStaleFrontmatterKeyPages,
 * stripStaleFrontmatterKeys).
 *
 * `held` and `wantedProducers` are passed to the store, where no page is held and no wanted link exists: `held:
 * 'exclude'` and `wantedProducers` change nothing and `held: 'only'` matches nothing, as in PGLite while those tables
 * are empty (rust/docs/store/extraction.md).
 */
import type { ExtractionLagCounts, ExtractionLagQuery } from '../../engine-sql/entity-reads.ts';
import type { StalePageRow } from '../../types.ts';
import { rowToStalePage } from '../../utils.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';

const STALE_OPTIONS = ['sourceId', 'versionTs', 'attendance', 'held', 'wantedProducers'] as const;

type StaleOpts = { sourceId?: string; versionTs?: string; attendance?: 'exclude' | 'blocked'; held?: 'exclude' | 'only'; wantedProducers?: readonly string[] };
type ListStaleOpts = { batchSize: number; afterPageId?: number; sourceId?: string; versionTs?: string; held?: 'exclude'; wantedProducers?: readonly string[] };

export const countStalePagesForExtraction: StoreMember<[opts?: StaleOpts], number> = (brain, opts) => {
  const o = takeOptions('countStalePagesForExtraction', opts, STALE_OPTIONS);
  return storeCall({ member: 'countStalePagesForExtraction', sourceId: o.sourceId as string | undefined }, () => brain.countStalePagesForExtraction(o));
};

export const listStalePagesForExtraction: StoreMember<[opts: ListStaleOpts], StalePageRow[]> = async (brain, opts) => {
  const o = takeOptions('listStalePagesForExtraction', opts, ['batchSize', 'afterPageId', ...STALE_OPTIONS]);
  const rows: Record<string, unknown>[] = await storeCall({ member: 'listStalePagesForExtraction', sourceId: o.sourceId as string | undefined }, () =>
    brain.listStalePagesForExtraction(o));
  return rows.map(rowToStalePage);
};

/**
 * The link-extraction lag row (`extractionLagStatement`) from the same stale predicate: live pages, the stale ones
 * extraction can clear, the attendance-blocked ones and the held ones (always 0: no page is held here). `timeoutMs`
 * bounds a database statement; the store read has none to bound, so it is ignored.
 */
export const readExtractionLagCounts: StoreMember<[q: ExtractionLagQuery], ExtractionLagCounts | undefined> = (brain, q) => {
  const o = takeOptions('readExtractionLagCounts', q, ['sourceId', 'versionTs', 'attendance', 'held', 'guests', 'wantedProducers'], ['timeoutMs']);
  return storeCall({ member: 'readExtractionLagCounts', sourceId: o.sourceId as string | undefined }, () => brain.readExtractionLagCounts(o));
};

export const markPagesExtractedBatch: StoreMember<[refs: Array<{ slug: string; source_id: string; extractedAt?: string }>, defaultExtractedAt: string], number> =
  async (brain, refs, defaultExtractedAt) => {
    if (refs.length === 0) return 0;
    return storeCall({ member: 'markPagesExtractedBatch' }, () => brain.markPagesExtractedBatch(refs, defaultExtractedAt));
  };

export const markPagesAttendanceBlocked: StoreMember<[refs: Array<{ slug: string; source_id: string; revision: string }>], number> = async (brain, refs) => {
  if (refs.length === 0) return 0;
  return storeCall({ member: 'markPagesAttendanceBlocked' }, () => brain.markPagesAttendanceBlocked(refs));
};

export const countStaleFrontmatterKeyPages: StoreMember<[opts: { sourceIds: string[] }], Array<{ source_id: string; n: number }>> = async (brain, opts) => {
  const o = takeOptions('countStaleFrontmatterKeyPages', opts, ['sourceIds']);
  if (!Array.isArray(o.sourceIds) || o.sourceIds.length === 0) return [];
  return storeCall({ member: 'countStaleFrontmatterKeyPages' }, () => brain.countStaleFrontmatterKeyPages(o));
};

export const listStaleFrontmatterKeyPages: StoreMember<[opts: { sourceId: string; afterId: number; limit: number }], Array<{ id: number; slug: string; keys: string[] }>> =
  (brain, opts) => {
    const o = takeOptions('listStaleFrontmatterKeyPages', opts, ['sourceId', 'afterId', 'limit']);
    return storeCall({ member: 'listStaleFrontmatterKeyPages', sourceId: o.sourceId as string | undefined }, () => brain.listStaleFrontmatterKeyPages(o));
  };

export const stripStaleFrontmatterKeys: StoreMember<[opts: { sourceId: string; ids: number[] }], number> = async (brain, opts) => {
  const o = takeOptions('stripStaleFrontmatterKeys', opts, ['sourceId', 'ids']);
  if (!Array.isArray(o.ids) || o.ids.length === 0) return 0;
  return storeCall({ member: 'stripStaleFrontmatterKeys', sourceId: o.sourceId as string | undefined }, () => brain.stripStaleFrontmatterKeys(o));
};

// The extract receipt write's page reads and the extract_rollup_7d day upsert (engine-sql/extract-bookkeeping.ts).
export * from './extract-bookkeeping.ts';
