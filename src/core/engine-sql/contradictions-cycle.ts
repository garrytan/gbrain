/**
 * The contradiction statements outside the stored-finding store: the edge-contradiction dream phase and its
 * proposals (`link_edge_proposals`), the `gbrain edge-proposals` command's own reads and writes of those proposals,
 * the scoped reader's live re-reads of judged chunks and takes, and the two small eval reads (last prompt version,
 * captured queries). The text and binds are the ones the callers built inline; the engines run them through typed
 * members.
 */
import { ownerOnlyTakeAllowedSql } from '../search/private-visibility.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { NON_EMPLOYER_PREFIXES, NON_EMPLOYER_TYPES } from '../link-target-roles.ts';
import { entityTypePredicateSql, type EntityTypeFilter } from '../schema-pack/entity-types.ts';
import { projectionEligibleSql } from '../eligibility/sql.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { chunkVisibleFilter, requiresSafeChunks, safeChunksFilter } from '../search/safe-chunks.ts';
import type { TrustTier } from '../trust/tier.ts';
import type { PageReadPolicy } from '../types.ts';

export type { EngineRawRead };

// ─── The edge-contradictions phase ───────────────────────────────────────

export interface EdgeCandidateRow {
  source_id: string; from_page_id: number; to_page_id: number; link_type: string;
  valid_ranges: string; last_start: unknown; recorded_at: unknown; evidence_hash: string;
  subject_slug: string; subject_title: string | null; target_slug: string; target_title: string | null;
}

export interface EdgeCandidateQuery {
  /** The UTC day the relationships must hold on (YYYY-MM-DD). */
  today: string;
  maxSubjects: number;
  /** Subjects whose links were re-derived before this instant are skipped; null admits every subject. */
  pendingCutoff: string | null;
  /** The person-like page types of the source's pack (#6953). */
  personFilter: EntityTypeFilter;
}

/**
 * The live state relationships of subjects with two or more targets of the same type, newest groups first, bounded
 * by `maxSubjects`. A works_at member is admitted only when its subject is person-like and its target is neither
 * person-like nor a non-employer type.
 */
export async function listEdgeContradictionCandidates(raw: EngineRawRead, q: EdgeCandidateQuery): Promise<EdgeCandidateRow[]> {
  const isPerson = (alias: 'f' | 't') => entityTypePredicateSql(alias, q.personFilter);
  const sql = renderFragment(sqlFragment`WITH live AS (
       SELECT lr.* FROM link_relationships lr
         JOIN pages f ON f.id = lr.from_page_id AND f.deleted_at IS NULL
         JOIN pages t ON t.id = lr.to_page_id AND t.deleted_at IS NULL
        WHERE lr.scope = 'all' AND lr.semantics = 'state' AND lr.valid_ranges @> ${q.today}::date
          AND (lr.link_type <> 'works_at' OR (${isPerson('f')} AND NOT ${isPerson('t')} AND
            CASE WHEN NULLIF(t.type, '') IS NOT NULL THEN NOT (t.type = ANY(${[...NON_EMPLOYER_TYPES]}::text[]))
              ELSE NOT EXISTS (SELECT 1 FROM unnest(${[...NON_EMPLOYER_PREFIXES]}::text[]) AS prefix(value)
                WHERE starts_with(t.slug, prefix.value)) END))
     ), multi AS (
       SELECT source_id, from_page_id, link_type FROM live
        GROUP BY 1, 2, 3 HAVING count(DISTINCT to_page_id) >= 2
        ORDER BY max(refreshed_at) DESC, from_page_id, link_type COLLATE "C" LIMIT ${q.maxSubjects}
     )
     SELECT l.source_id, l.from_page_id, l.to_page_id, l.link_type, l.valid_ranges::text AS valid_ranges,
            l.last_start, l.recorded_at, l.evidence_hash,
            f.slug AS subject_slug, f.title AS subject_title, t.slug AS target_slug, t.title AS target_title
       FROM live l JOIN multi m USING (source_id, from_page_id, link_type)
       JOIN pages f ON f.id = l.from_page_id AND f.deleted_at IS NULL
         AND (${q.pendingCutoff}::timestamptz IS NULL OR f.links_extracted_at >= ${q.pendingCutoff}::timestamptz)
       JOIN pages t ON t.id = l.to_page_id AND t.deleted_at IS NULL
      ORDER BY l.from_page_id, l.link_type COLLATE "C", l.last_start NULLS FIRST, t.slug COLLATE "C"`);
  return raw<EdgeCandidateRow>(sql.text, sql.params);
}

export interface KnownEdgeProposalRow { a: number; b: number; status: string; detail: string | null; recent: boolean }

/** The proposals of one subject and link type whose evidence hash is among `evidenceHashes`, with whether each was touched in the last 24 hours. */
export async function listKnownEdgeProposals(raw: EngineRawRead, fromPageId: number, linkType: string, evidenceHashes: string[]): Promise<KnownEdgeProposalRow[]> {
  return raw<KnownEdgeProposalRow>(
    `SELECT a_to_page_id AS a, b_to_page_id AS b, status, detail, updated_at > now() - interval '24 hours' AS recent FROM link_edge_proposals
        WHERE from_page_id = $1 AND link_type = $2 AND evidence_hash = ANY($3::text[])`,
    [fromPageId, linkType, evidenceHashes]);
}

/** Up to three distinct non-empty contexts of one link. */
export async function listLinkContexts(raw: EngineRawRead, fromPageId: number, toPageId: number, linkType: string): Promise<string[]> {
  const rows = await raw<{ context: string }>(
    `SELECT DISTINCT context FROM links WHERE from_page_id = $1 AND to_page_id = $2 AND link_type = $3 AND context <> '' LIMIT 3`,
    [fromPageId, toPageId, linkType]);
  return rows.map(c => c.context);
}

export interface EdgeProposalInput {
  sourceId: string; fromPageId: number; aToPageId: number; bToPageId: number; linkType: string; evidenceHash: string;
  status: string; endingToPageId: number | null; closeDate: string | null; bornClosed: boolean; model: string;
  confidence: number | null; generatedLine: string | null; detail: string | null;
}

/** Records a proposal; an existing row for the same evidence is replaced only while it is an error row. Returns the row id, null when the existing row stood. */
export async function recordEdgeProposal(raw: EngineRawRead, p: EdgeProposalInput): Promise<number | null> {
  const rows = await raw<{ id: number }>(
    `INSERT INTO link_edge_proposals (source_id, from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash, status,
       ending_to_page_id, close_date, born_closed, model, confidence, generated_line, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12, $13, $14)
     ON CONFLICT (from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash) DO UPDATE SET
       status = EXCLUDED.status, ending_to_page_id = EXCLUDED.ending_to_page_id, close_date = EXCLUDED.close_date,
       born_closed = EXCLUDED.born_closed, model = EXCLUDED.model, confidence = EXCLUDED.confidence,
       generated_line = EXCLUDED.generated_line, detail = EXCLUDED.detail, updated_at = now()
     WHERE link_edge_proposals.status = 'error'
     RETURNING id`,
    [p.sourceId, p.fromPageId, p.aToPageId, p.bToPageId, p.linkType, p.evidenceHash, p.status,
      p.endingToPageId, p.closeDate, p.bornClosed, p.model, p.confidence, p.generatedLine, p.detail]);
  return rows[0] ? Number(rows[0].id) : null;
}

export interface EdgeProposalRow {
  id: number; source_id: string; status: string; from_page_id: number; ending_to_page_id: number | null;
  link_type: string; close_date: unknown; generated_line: string | null; subject_slug: string; ending_slug: string | null;
}

/** One proposal with its subject and ending page slugs, null when there is none. */
export async function readEdgeProposal(raw: EngineRawRead, id: number): Promise<EdgeProposalRow | null> {
  const [row] = await raw<EdgeProposalRow>(
    `SELECT p.id, p.source_id, p.status, p.from_page_id, p.ending_to_page_id, p.link_type, p.close_date::text AS close_date,
            p.generated_line, f.slug AS subject_slug, t.slug AS ending_slug
       FROM link_edge_proposals p JOIN pages f ON f.id = p.from_page_id LEFT JOIN pages t ON t.id = p.ending_to_page_id
      WHERE p.id = $1`, [id]);
  return row ?? null;
}

/** Does a dream transition end this relationship on `closeDate`? */
export async function edgeClosureLanded(raw: EngineRawRead, fromPageId: number, endingToPageId: number | null, linkType: string, closeDate: string | null): Promise<boolean> {
  const rows = await raw(
    `SELECT 1 FROM link_transitions WHERE origin_page_id = $1 AND from_page_id = $1 AND to_page_id = $2 AND link_type = $3
        AND kind = 'end' AND producer = 'dream' AND occurred_on = $4::date LIMIT 1`,
    [fromPageId, endingToPageId, linkType, closeDate]);
  return rows.length > 0;
}

/** The evidence hashes the two relationships of a proposal carry now, null when either is gone. */
export async function readEdgeProposalEvidence(raw: EngineRawRead, id: number): Promise<{ a: string; b: string } | null> {
  const [current] = await raw<{ a: string; b: string }>(
    `SELECT la.evidence_hash AS a, lb.evidence_hash AS b FROM link_edge_proposals pr
       JOIN link_relationships la ON la.from_page_id = pr.from_page_id AND la.to_page_id = pr.a_to_page_id AND la.link_type = pr.link_type AND la.scope = 'all'
       JOIN link_relationships lb ON lb.from_page_id = pr.from_page_id AND lb.to_page_id = pr.b_to_page_id AND lb.link_type = pr.link_type AND lb.scope = 'all'
      WHERE pr.id = $1`, [id]);
  return current ?? null;
}

/** The evidence hash a proposal was judged on, null when there is no such proposal. */
export async function readEdgeProposalHash(raw: EngineRawRead, id: number): Promise<{ evidence_hash: string } | null> {
  const [stored] = await raw<{ evidence_hash: string }>(`SELECT evidence_hash FROM link_edge_proposals WHERE id = $1`, [id]);
  return stored ?? null;
}

/** Marks a proposal stale: its relationships changed since the judgment. */
export async function markEdgeProposalStale(raw: EngineRawRead, id: number): Promise<void> {
  await raw(`UPDATE link_edge_proposals SET status = 'stale', updated_at = now() WHERE id = $1`, [id]);
}

/** Sets a proposal's status (applied once its closure landed, proposed otherwise). */
export async function setEdgeProposalStatus(raw: EngineRawRead, id: number, status: string): Promise<void> {
  await raw(`UPDATE link_edge_proposals SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
}

/** Rejects a proposal that is still open; true when it was. */
export async function rejectOpenEdgeProposal(raw: EngineRawRead, id: number): Promise<boolean> {
  const rows = await raw(`UPDATE link_edge_proposals SET status = 'rejected', updated_at = now() WHERE id = $1 AND status IN ('proposed','undated_unresolved','ambiguous_same_date') RETURNING 1`, [id]);
  return rows.length > 0;
}

/** Marks an applied proposal undone. */
export async function markEdgeProposalUndone(raw: EngineRawRead, id: number): Promise<void> {
  await raw(`UPDATE link_edge_proposals SET status = 'undone', updated_at = now() WHERE id = $1`, [id]);
}

/** Applied proposals whose closure transition is gone become reverted_by_user; returns how many. */
export async function markRevertedEdgeProposals(raw: EngineRawRead): Promise<number> {
  const rows = await raw<{ id: number }>(
    `UPDATE link_edge_proposals p SET status = 'reverted_by_user', updated_at = now()
      WHERE p.status = 'applied' AND p.updated_at < now() AND NOT EXISTS (
        SELECT 1 FROM link_transitions t WHERE t.origin_page_id = p.from_page_id AND t.from_page_id = p.from_page_id
          AND t.to_page_id = p.ending_to_page_id AND t.link_type = p.link_type AND t.kind = 'end' AND t.producer = 'dream'
          AND t.occurred_on = p.close_date)
      RETURNING p.id`);
  return rows.length;
}

// ─── gbrain edge-proposals (src/commands/edge-proposals.ts) ─────────────

/** One proposal as `gbrain edge-proposals` lists and shows it: the subject, the two targets and the ending page as slugs. */
export interface EdgeProposalCliRow {
  id: number | string; status: string; link_type: string; subject: string; a_target: string; b_target: string; ending: string | null;
  close_date: unknown; born_closed: boolean; model: string | null; confidence: number | null; generated_line: string | null; created_at: unknown;
}

/** The proposals the command reads: every one, those with one of `statuses`, the one with `id`, or that one only while it is undated. */
export type EdgeProposalCliFilter = { kind: 'all' } | { kind: 'statuses'; statuses: string[] } | { kind: 'id'; id: number } | { kind: 'undated'; id: number };

/** The WHERE clause of each filter, with its `$1` bind. */
const EDGE_PROPOSAL_CLI_WHERE = {
  all: 'TRUE',
  statuses: 'p.status = ANY($1::text[])',
  id: 'p.id = $1',
  undated: `p.id = $1 AND p.status = 'undated_unresolved'`,
} as const satisfies Record<EdgeProposalCliFilter['kind'], string>;

/**
 * The proposals of `filter`, newest first, at most `limit` (a whole number from 1 to 1000, which the command clamps);
 * a proposal whose subject or target page is gone is not listed.
 */
export async function listEdgeProposalCliRows(raw: EngineRawRead, filter: EdgeProposalCliFilter, limit: number): Promise<EdgeProposalCliRow[]> {
  if (!Number.isFinite(limit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error(`listEdgeProposalCliRows: limit ${limit} is not a whole number from 1 to 1000`);
  const where = trustedSql(EDGE_PROPOSAL_CLI_WHERE[filter.kind]);
  const cap = trustedSql(`${limit}`);
  const { text } = renderFragment(sqlFragment`SELECT p.id, p.status, p.link_type, f.slug AS subject, ta.slug AS a_target, tb.slug AS b_target, te.slug AS ending,
            p.close_date::text AS close_date, p.born_closed, p.model, p.confidence, p.generated_line, p.created_at
       FROM link_edge_proposals p
       JOIN pages f ON f.id = p.from_page_id JOIN pages ta ON ta.id = p.a_to_page_id JOIN pages tb ON tb.id = p.b_to_page_id
       LEFT JOIN pages te ON te.id = p.ending_to_page_id
      WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ${cap}`);
  const params = filter.kind === 'all' ? [] : filter.kind === 'statuses' ? [filter.statuses] : [filter.id];
  return raw<EdgeProposalCliRow>(text, params);
}

/** `retry --all-held`: deletes the judge errors held after their attempts; the deleted ids. */
export async function deleteHeldEdgeProposalErrors(raw: EngineRawRead): Promise<Array<{ id: number }>> {
  return raw<{ id: number }>(`DELETE FROM link_edge_proposals WHERE status = 'error' AND detail LIKE 'held after %' RETURNING id`);
}

/** `undo --all-applied`: the applied proposals, in id order. */
export async function listAppliedEdgeProposalIds(raw: EngineRawRead): Promise<Array<{ id: number }>> {
  return raw<{ id: number }>(`SELECT id FROM link_edge_proposals WHERE status = 'applied' ORDER BY id`);
}

/** `retry <id>`: deletes the proposal while it is a judge error; the deleted id, none when it was not one. */
export async function deleteEdgeProposalError(raw: EngineRawRead, id: number): Promise<Array<{ id: number }>> {
  return raw<{ id: number }>(`DELETE FROM link_edge_proposals WHERE id = $1 AND status = 'error' RETURNING id`, [id]);
}

/** `date`: the source of the proposal, null when there is no such proposal. */
export async function readEdgeProposalSourceId(raw: EngineRawRead, id: number): Promise<string | null> {
  const [row] = await raw<{ source_id: string }>(`SELECT source_id FROM link_edge_proposals WHERE id = $1`, [id]);
  return row?.source_id ?? null;
}

/** `date`: rejects the proposal the user dated. */
export async function markEdgeProposalDated(raw: EngineRawRead, id: number): Promise<void> {
  await raw(`UPDATE link_edge_proposals SET status = 'rejected', detail = 'dated by user', updated_at = now() WHERE id = $1`, [id]);
}

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

// ─── Eval reads ──────────────────────────────────────────────────────────

/** The prompt version of the most recent persisted contradiction run, null when none ran. */
export async function readLastContradictionsPromptVersion(raw: EngineRawRead): Promise<string | null> {
  const rows = await raw<{ prompt_version: string }>(`SELECT prompt_version FROM eval_contradictions_runs ORDER BY ran_at DESC LIMIT 1`);
  return rows && rows.length > 0 && typeof rows[0].prompt_version === 'string' ? rows[0].prompt_version : null;
}

/** The newest captured queries, at most `limit`. */
export async function listEvalCandidateQueries(raw: EngineRawRead, limit: number): Promise<string[]> {
  const rows = await raw<{ query: string }>(`SELECT query FROM eval_candidates WHERE query IS NOT NULL ORDER BY id DESC LIMIT $1`, [limit]);
  return rows.map(r => r.query);
}
