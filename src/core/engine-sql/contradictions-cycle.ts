/**
 * The contradiction statements outside the stored-finding store: the edge-contradiction dream phase and its
 * proposals (`link_edge_proposals`), the scoped reader's live re-reads of judged chunks and takes, and the two
 * small eval reads (last prompt version, captured queries). The text and binds are the ones the callers built
 * inline; the engines run them through typed members.
 */
import { ownerOnlyTakeAllowedSql } from '../search/private-visibility.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import { projectionEligibleSql } from '../eligibility/sql.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { chunkVisibleFilter, requiresSafeChunks, safeChunksFilter } from '../search/safe-chunks.ts';
import type { TrustTier } from '../trust/tier.ts';
import type { PageReadPolicy } from '../types.ts';

// ─── The scoped contradiction reader ─────────────────────────────────────

export interface LiveChunkRow { id: number; page_id: number; slug: string; source_id: string; chunk_text: string }
export interface LiveTakeRow { id: number; page_id: number; slug: string; source_id: string; row_num: number; claim: string; holder: string }

/** The constant heads of the two live re-reads; the page policy and the visibility predicates follow them. */
// chunk-visibility-ok: a head only; listLiveChunksByIds appends chunkVisibleFilter(p, cc) to it
const LIVE_CHUNKS_HEAD = `SELECT cc.id, cc.page_id, cc.chunk_text, p.slug, p.source_id
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.id = ANY($1::int[]) AND `;
const LIVE_TAKES_HEAD = `SELECT t.id, t.page_id, t.row_num, t.claim, t.holder, p.slug, p.source_id
       FROM takes t JOIN pages p ON p.id = t.page_id
      WHERE t.id = ANY($1::bigint[]) AND t.active AND `;
const TAKE_HOLDER_HEAD = ' AND t.holder = ANY($';
const TAKE_HOLDER_TAIL = '::text[])';

/** The holder allow-list conjunct bound as the `position`-th value. Only a positive integer is spliced. */
function takeHolderSql(position: number): string {
  if (!Number.isSafeInteger(position) || position < 1) throw new Error(`takeHolderSql: bad position ${position}`);
  return TAKE_HOLDER_HEAD + position + TAKE_HOLDER_TAIL;
}

/** The live chunks with these ids that the caller's read policy admits (and the trust floor, when one is set). */
export async function listLiveChunksByIds(raw: EngineRawRead, ids: number[], policy: PageReadPolicy, floor: TrustTier | undefined): Promise<LiveChunkRow[]> {
  const params: unknown[] = [ids];
  const pageSql = pageReadFilter('p', { ...policy, ...(floor ? { minTrust: floor } : {}) }, params, true);
  const safe = requiresSafeChunks(policy) ? ` AND ${safeChunksFilter('p')}` : '';
  return raw<LiveChunkRow>(`${LIVE_CHUNKS_HEAD}${pageSql} AND ${chunkVisibleFilter('p', 'cc')}${safe}`, params);
}

/** The active takes with these ids that the caller's read policy admits: page policy, holder allow-list, the owner-only take rule (#9704) and the trust floor. */
export async function listLiveTakesByIds(raw: EngineRawRead, ids: number[], policy: PageReadPolicy, floor: TrustTier | undefined): Promise<LiveTakeRow[]> {
  const params: unknown[] = [ids];
  const pageSql = pageReadFilter('p', policy, params, true);
  let holderSql = '';
  if (policy.takesHoldersAllowList !== undefined) {
    params.push(policy.takesHoldersAllowList);
    holderSql = takeHolderSql(params.length);
  }
  return raw<LiveTakeRow>(`${LIVE_TAKES_HEAD}${pageSql}${holderSql}${policy.excludePrivate ? ownerOnlyTakeAllowedSql('t') : ''}
        AND ${projectionEligibleSql('takes', 't', floor ? { floor } : undefined)}`, params);
}
