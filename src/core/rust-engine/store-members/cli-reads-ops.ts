/**
 * The CLI search and graph reads (BrainEngine scanExactBatch, nextLivePageAfter, listExactIdentityCandidates,
 * rankEntities, listExtractionPendingPages), served by gbrain-store `cli_reads::reads`. What the store does not keep
 * (trust tiers, page aliases) and what each member answers for it:
 * rust/docs/store/cli-reads-ops.md.
 */
import type { ExtractionPendingRow } from '../../engine-sql/cli-reads-ops.ts';
import type { ExactIdentityRow, ExactIdentityStatementOpts } from '../../engine-sql/exact-identity.ts';
import type { RankEntitiesStatementOpts, RankEntityRow } from '../../engine-sql/graph-rank.ts';
import type { ExactBatchRow, ExactScanOpts } from '../../search/exact-scan.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

/**
 * One batch of the exact-phrase scan. The words split as `phrasePattern` splits them; the store matches them joined
 * by `[[:space:]]+`. A remote caller matches only safe-fenced chunks and sees a page below the fence as `unsealed`;
 * `excludePrivate` sends the caller's page policy. `minTrust` refuses: the store keeps no trust tiers.
 */
export const scanExactBatch: StoreMember<[opts: ExactScanOpts, afterPageId: number, batchPages: number, timeoutMs: number], ExactBatchRow[] | null> =
  async (brain, opts, afterPageId, batchPages) => {
    const taken = takeOptions('scanExactBatch', opts,
      ['phrase', 'caseSensitive', 'sourceId', 'sourceIds', 'types', 'slugPrefix', 'excludeSlugPrefixes', 'remote', 'excludePrivate'],
      ['limit', 'afterPageId', 'deadlineMs', 'batchPages']);
    const words = String(taken.phrase ?? '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;
    const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
    const excludePrivate = storePagePolicy('scanExactBatch', taken.excludePrivate, { callerReaders: true });
    return storeCall({ member: 'scanExactBatch' }, () => brain.scanExactBatch({
      words, longest, caseSensitive: taken.caseSensitive === true,
      sourceId: taken.sourceId, sourceIds: taken.sourceIds, types: taken.types, slugPrefix: taken.slugPrefix,
      excludeSlugPrefixes: taken.excludeSlugPrefixes ?? [], after: afterPageId, batchPages,
      remote: taken.remote === true, excludePrivate: excludePrivate ?? null,
    }));
  };

export const nextLivePageAfter: StoreMember<[afterPageId: number], { id: number; slug: string; source_id: string } | null> =
  (brain, afterPageId) => storeCall({ member: 'nextLivePageAfter' }, () => brain.nextLivePageAfter(afterPageId));

/**
 * A remote caller with `excludePrivate` reads through its page policy: the SQL statement adds
 * `privatePagesFilterForCaller`, and the store gets the same filter as a policy (readers, grants and lineage included).
 */
function withRemotePolicy<T extends { remote?: { excludePrivate?: boolean } }>(member: string, opts: T): T {
  if (!opts.remote?.excludePrivate) return opts;
  return { ...opts, remote: { ...opts.remote, policy: storePagePolicy(member, true, { callerReaders: true }) } };
}

export const listExactIdentityCandidates: StoreMember<[opts: ExactIdentityStatementOpts], ExactIdentityRow[]> = (brain, opts) => {
  const sent = withRemotePolicy('listExactIdentityCandidates', opts);
  return storeCall({ member: 'listExactIdentityCandidates' }, () => brain.listExactIdentityCandidates(sent));
};

export const rankEntities: StoreMember<[opts: RankEntitiesStatementOpts, timeoutMs: number], RankEntityRow[]> = (brain, opts) => {
  const sent = withRemotePolicy('rankEntities', opts);
  return storeCall({ member: 'rankEntities' }, () => brain.rankEntities(sent));
};

export const listExtractionPendingPages: StoreMember<[opts: { sourceIds?: string[]; sourceId?: string; limit: number; offset: number }], ExtractionPendingRow[]> =
  (brain, opts) => storeCall({ member: 'listExtractionPendingPages' }, () => brain.listExtractionPendingPages(opts));
