/**
 * The CLI search and graph reads (BrainEngine scanExactBatch, nextLivePageAfter, listExactIdentityCandidates,
 * rankEntities, listExtractionPendingPages), served by gbrain-store `cli_reads::reads`. What the store does not keep
 * (private visibility, trust tiers, the safe-chunk fence, page aliases) and what each member answers for it:
 * rust/docs/store/cli-reads-ops.md.
 */
import type { ExtractionPendingRow } from '../../engine-sql/cli-reads-ops.ts';
import type { ExactIdentityRow, ExactIdentityStatementOpts } from '../../engine-sql/exact-identity.ts';
import type { RankEntitiesStatementOpts, RankEntityRow } from '../../engine-sql/graph-rank.ts';
import type { ExactBatchRow, ExactScanOpts } from '../../search/exact-scan.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';

/**
 * One batch of the exact-phrase scan. The words split as `phrasePattern` splits them; the store matches them joined
 * by `[[:space:]]+`. A remote caller reads only safe-fenced chunks, which the store does not mark, so it refuses.
 */
export const scanExactBatch: StoreMember<[opts: ExactScanOpts, afterPageId: number, batchPages: number, timeoutMs: number], ExactBatchRow[] | null> =
  async (brain, opts, afterPageId, batchPages) => {
    const taken = takeOptions('scanExactBatch', opts,
      ['phrase', 'caseSensitive', 'sourceId', 'sourceIds', 'types', 'slugPrefix', 'excludeSlugPrefixes'],
      ['limit', 'afterPageId', 'deadlineMs', 'batchPages']);
    const words = String(taken.phrase ?? '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;
    const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
    return storeCall({ member: 'scanExactBatch' }, () => brain.scanExactBatch({
      words, longest, caseSensitive: taken.caseSensitive === true,
      sourceId: taken.sourceId, sourceIds: taken.sourceIds, types: taken.types, slugPrefix: taken.slugPrefix,
      excludeSlugPrefixes: taken.excludeSlugPrefixes ?? [], after: afterPageId, batchPages,
    }));
  };

export const nextLivePageAfter: StoreMember<[afterPageId: number], { id: number; slug: string; source_id: string } | null> =
  (brain, afterPageId) => storeCall({ member: 'nextLivePageAfter' }, () => brain.nextLivePageAfter(afterPageId));

export const listExactIdentityCandidates: StoreMember<[opts: ExactIdentityStatementOpts], ExactIdentityRow[]> = (brain, opts) => {
  if (opts.remote?.excludePrivate) refuseMember('listExactIdentityCandidates', 'remote.excludePrivate');
  return storeCall({ member: 'listExactIdentityCandidates' }, () => brain.listExactIdentityCandidates(opts));
};

export const rankEntities: StoreMember<[opts: RankEntitiesStatementOpts, timeoutMs: number], RankEntityRow[]> = (brain, opts) => {
  if (opts.remote?.excludePrivate) refuseMember('rankEntities', 'remote.excludePrivate');
  return storeCall({ member: 'rankEntities' }, () => brain.rankEntities(opts));
};

export const listExtractionPendingPages: StoreMember<[opts: { sourceIds?: string[]; sourceId?: string; limit: number; offset: number }], ExtractionPendingRow[]> =
  (brain, opts) => storeCall({ member: 'listExtractionPendingPages' }, () => brain.listExtractionPendingPages(opts));
