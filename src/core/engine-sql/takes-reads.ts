/**
 * The small reads that doctor, onboarding, the fact purge, the fence import, the scorecard's MCP count and the take
 * supersession repair made through `executeRaw`: take counts and rows, the pages whose salience weight lags their
 * takes, and whether a source owns unresolved code edges. SQL once for both engines, so a store that is not SQL
 * serves the same members (rust/docs/store/takes-reads.md).
 *
 * Every function takes the engine (or transaction) it runs on. Counts come back as numbers.
 */
import type { BrainEngine } from '../engine.ts';
import { ownerOnlyTakeAllowedSql, privatePagesFilterForCaller } from '../search/private-visibility.ts';
import { storedTrustTier, type TrustTier } from '../trust/tier.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { QUARANTINE_KEY } from '../quarantine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** `takes.weight` is a `real` on a 0.05 grid: how many takes sit more than 0.001 off it, of how many. */
export async function countOffGridTakeWeights(tx: Raw): Promise<{ off_grid: number; total: number }> {
  const rows = await tx.executeRaw<{ off_grid: string | number; total: string | number }>(
    `SELECT
       count(*) FILTER (WHERE weight IS NOT NULL
                        AND abs(weight::numeric - ROUND(weight::numeric * 20) / 20) > 0.001)::int AS off_grid,
       count(*)::int AS total
     FROM takes`,
  );
  return { off_grid: num(rows[0]?.off_grid), total: num(rows[0]?.total) };
}

/** How many takes the brain holds, whatever their page. */
export async function countTakes(tx: Raw): Promise<number> {
  const rows = await tx.executeRaw<{ count: string | number }>('SELECT COUNT(*) AS count FROM takes');
  return num(rows[0]?.count);
}

export interface PurgeTakesSpec {
  sourceId: string;
  /** The purged facts: the takes they were consolidated into are purged with them. */
  factIds: readonly number[];
  /** `gbrain_fact_fingerprint` of the purged claim. */
  factHash: string;
  /** A page slug, or `*` for every page of the source. */
  subject: string;
}

/** The takes a fact purge removes: consolidated from a purged fact, or echoing the purged claim, in the source. */
export async function planFactPurgeTakes(tx: Raw, spec: PurgeTakesSpec): Promise<Array<{ id: number; page_id: number }>> {
  const rows = await tx.executeRaw<{ id: number | string; page_id: number | string }>(
    `SELECT DISTINCT k.id,k.page_id FROM takes k JOIN pages p ON p.id=k.page_id
      WHERE p.source_id=$1 AND (k.id IN (SELECT consolidated_into FROM facts WHERE id=ANY($2::bigint[]) AND consolidated_into IS NOT NULL)
        OR (gbrain_fact_fingerprint(k.claim)=$3 AND ($4='*' OR p.slug=$4))) ORDER BY k.id`,
    [spec.sourceId, [...spec.factIds], spec.factHash, spec.subject]);
  return rows.map(t => ({ id: Number(t.id), page_id: Number(t.page_id) }));
}

/** The page's stored takes by row number, row number to claim. */
export async function listTakeRowsForPage(tx: Raw, pageId: number): Promise<Array<{ row_num: number; claim: string }>> {
  const rows = await tx.executeRaw<{ row_num: number | string; claim: string }>(
    'SELECT row_num, claim FROM takes WHERE page_id=$1 ORDER BY row_num', [pageId]);
  return rows.map(r => ({ row_num: Number(r.row_num), claim: r.claim }));
}

/** Which fence generation `listHeldFenceTakeRows` checks: the page's take_fence generation in one source. */
export interface HeldFenceTakeSpec { sourceId: string; kind: string; ownerKey: string; pageId: number }

/** A stored take as the fence row it was, resolution cells included. */
export interface HeldFenceTakeRow {
  row_num: number; claim: string; kind: string; holder: string; weight: number; since_date: string | null; until_date: string | null;
  source: string | null; active: boolean; resolved_at: Date | string | null; resolved_quality: string | null; resolved_outcome: boolean | null;
  resolved_source: string | null; resolved_value: number | null; resolved_unit: string | null; resolved_by: string | null;
}

/** The page's stored takes by row number while its fence generation is held `fence_absent`; none otherwise. */
export async function listHeldFenceTakeRows(tx: Raw, spec: HeldFenceTakeSpec): Promise<HeldFenceTakeRow[]> {
  const held = await tx.executeRaw(`SELECT 1 FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held' AND held_reason='fence_absent'`,
    [spec.sourceId, spec.kind, spec.ownerKey]);
  if (!held.length) return [];
  return tx.executeRaw<HeldFenceTakeRow>(`SELECT row_num, claim, kind, holder, weight, since_date, until_date, source, active,
      resolved_at, resolved_quality, resolved_outcome, resolved_source, resolved_value, resolved_unit, resolved_by FROM takes WHERE page_id=$1 ORDER BY row_num`, [spec.pageId]);
}

export interface McpResolvedSpec {
  /** The source scope the caller's read policy resolved to; null is every source. */
  sourceIds: readonly string[] | null;
  /** The holders the caller may read; null is every holder. */
  holders: readonly string[] | null;
  /** Hide the pages the caller may not read (the private-provenance policy). */
  excludePrivate: boolean;
}

/** Resolved takes whose `resolved_by` carries the MCP server stamp, in the caller's source and holder scope. */
export async function countMcpResolvedTakes(tx: Raw, spec: McpResolvedSpec): Promise<number> {
  const privacy = spec.excludePrivate ? sqlFragment` AND ${trustedSql(`${privatePagesFilterForCaller('p')}${ownerOnlyTakeAllowedSql('t')}`)}` : sqlFragment``;
  const sources = spec.sourceIds ? sqlFragment` AND p.source_id = ANY(${[...spec.sourceIds]}::text[])` : sqlFragment``;
  const holders = spec.holders ? sqlFragment` AND t.holder = ANY(${[...spec.holders]}::text[])` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT count(*)::text AS n FROM takes t JOIN pages p ON p.id = t.page_id
    WHERE t.resolved_at IS NOT NULL AND t.resolved_by LIKE 'mcp:%'${privacy}${sources}${holders}`);
  const rows = await tx.executeRaw<{ n: string }>(text, params);
  return parseInt(rows[0]?.n ?? '0', 10);
}

/** The live pages of `sourceIds` with an inactive take or one whose source cell says `superseded by #`, by id. */
export async function listTakeSupersessionCandidates(
  tx: Raw, sourceIds: readonly string[],
): Promise<Array<{ id: number; source_id: string; slug: string }>> {
  const rows = await tx.executeRaw<{ id: number | string; source_id: string; slug: string }>(
    `SELECT p.id, p.source_id, p.slug FROM pages p
      WHERE p.source_id = ANY($1::text[]) AND p.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM takes t WHERE t.page_id = p.id AND (t.active = false OR t.source ILIKE '%superseded by #%'))
      ORDER BY p.id`, [[...sourceIds]]);
  return rows.map(r => ({ id: Number(r.id), source_id: r.source_id, slug: r.slug }));
}

/** Pages with an active take whose emotional weight is still zero, and pages whose weight is above zero. */
export async function countZeroWeightWithTakes(tx: Raw): Promise<{ zero_weight_with_takes: number; nonzero_weight: number }> {
  const rows = await tx.executeRaw<{ kind: string; n: string }>(
    `SELECT 'zero_weight_with_takes' AS kind, COUNT(DISTINCT p.id)::text AS n
       FROM pages p
       JOIN takes t ON t.page_id = p.id AND t.active = TRUE
      WHERE COALESCE(p.emotional_weight, 0) = 0
     UNION ALL
     SELECT 'nonzero_weight', COUNT(*)::text FROM pages WHERE COALESCE(emotional_weight, 0) > 0`,
  );
  const counts = new Map(rows.map(r => [r.kind, Number(r.n)]));
  return { zero_weight_with_takes: counts.get('zero_weight_with_takes') ?? 0, nonzero_weight: counts.get('nonzero_weight') ?? 0 };
}

/** Whether the source owns an unresolved (symbol-target) code edge. */
export async function hasCodeEdgesSymbol(tx: Raw, sourceId: string): Promise<boolean> {
  const [owned] = await tx.executeRaw<{ e: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM code_edges_symbol WHERE source_id = $1) AS e', [sourceId]);
  return !!owned?.e;
}

// ---- The reads and the delete of `gbrain extract takes` (cycle/extract-takes.ts, generations/adapters/take-rows.ts) ----
// Each statement is the text the caller sent through `executeRaw`, byte for byte (test/engine-sql-takes-reads.test.ts).

/** The id of the live page `slug` in `sourceId`, or null. */
export async function readLivePageIdBySlug(tx: Raw, slug: string, sourceId: string): Promise<number | null> {
  const rows = await tx.executeRaw<{ id: number | string }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [slug, sourceId],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** A page's source, slug and stored trust tier (`unknown` when none is stored), deleted or not. */
export interface PageTierRef { source_id: string; slug: string; trust_tier: TrustTier }

/** Page `pageId`'s source, slug and stored trust tier, deleted or not; null when no page has the id. */
export async function readPageTierRef(tx: Raw, pageId: number): Promise<PageTierRef | null> {
  const [page] = await tx.executeRaw<{ source_id: string; slug: string; trust_tier: string | null }>('SELECT source_id, slug, trust_tier FROM pages WHERE id = $1', [pageId]);
  return page ? { source_id: page.source_id, slug: page.slug, trust_tier: storedTrustTier(page.trust_tier) } : null;
}

/** The pages among `ids`, deleted or not, with their source, slug and stored tier, in no set order. */
export async function readPageTierRows(tx: Raw, ids: readonly number[]): Promise<Array<PageTierRef & { id: number }>> {
  const rows = await tx.executeRaw<{ id: number | string; source_id: string; slug: string; trust_tier: string | null }>(
    'SELECT id,source_id,slug,trust_tier FROM pages WHERE id=ANY($1::int[])', [[...ids]]);
  return rows.map(r => ({ id: Number(r.id), source_id: r.source_id, slug: r.slug, trust_tier: storedTrustTier(r.trust_tier) }));
}

/** Whether page `pageId`'s frontmatter has the top-level key `key` (`frontmatter ? key`), deleted or not. */
export async function pageHasFrontmatterKey(tx: Raw, pageId: number, key: string): Promise<boolean> {
  return (await tx.executeRaw('SELECT 1 FROM pages WHERE id=$1 AND frontmatter ? $2', [pageId, key])).length > 0;
}

/**
 * Which of a page's takes a reconcile would remove: `removed` lists the takes at no row number of `rowNums`; `replaced`
 * lists the takes that no `rows` entry states at the same row number with the same claim. In no set order.
 */
export type TakesLeavingFence =
  | { change: 'removed'; rowNums: readonly number[] }
  | { change: 'replaced'; rows: ReadonlyArray<{ row_num: number; claim: string }> };

/** The ids of page `pageId`'s takes that leave its fence (`TakesLeavingFence`), in no set order. */
export async function listTakeIdsLeavingFence(tx: Raw, pageId: number, fence: TakesLeavingFence): Promise<number[]> {
  const rows = fence.change === 'removed'
    ? await tx.executeRaw<{ id: number | string }>(`SELECT id FROM takes WHERE page_id = $1 AND NOT (row_num = ANY($2::integer[]))`, [pageId, [...fence.rowNums]])
    : await tx.executeRaw<{ id: number | string }>(`SELECT id FROM takes WHERE page_id = $1 AND NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) AS f(row_num int, claim text) WHERE f.row_num = takes.row_num AND f.claim = takes.claim)`,
    [pageId, JSON.stringify(fence.rows.map(r => ({ row_num: r.row_num, claim: r.claim })))]);
  return rows.map(r => Number(r.id));
}

/** A take's before-state: every column but its vector and write attribution, as `jsonb_build_object` writes them. */
export interface TakePreimage {
  id: number; page_id: number; row_num: number; claim: string; kind: string; holder: string; weight: number;
  since_date: string | null; until_date: string | null; source: string | null; superseded_by: number | null; active: boolean;
  resolved_at: string | null; resolved_outcome: boolean | null; resolved_value: number | null; resolved_unit: string | null;
  resolved_source: string | null; resolved_by: string | null; resolved_quality: string | null;
}

/** The columns a take's before-state keeps (every column but its vector and write attribution). */
export const TAKE_PREIMAGE_SQL = `jsonb_build_object('id', k.id, 'page_id', k.page_id, 'row_num', k.row_num, 'claim', k.claim, 'kind', k.kind, 'holder', k.holder,
  'weight', k.weight, 'since_date', k.since_date, 'until_date', k.until_date, 'source', k.source, 'superseded_by', k.superseded_by, 'active', k.active,
  'resolved_at', k.resolved_at, 'resolved_outcome', k.resolved_outcome, 'resolved_value', k.resolved_value, 'resolved_unit', k.resolved_unit,
  'resolved_source', k.resolved_source, 'resolved_by', k.resolved_by, 'resolved_quality', k.resolved_quality)`;

/**
 * The before-states, by row number, of page `pageId`'s takes `ids` (`gone`) and of the takes an incoming row of the same
 * number would overwrite with another claim, kind or holder (`gone` false). The preimage is `TAKE_PREIMAGE_SQL` written out,
 * so the statement stays one literal; test/extract-takes-sql-pin.test.ts pins the two equal.
 */
export async function listTakePreimages(tx: Raw, pageId: number, ids: readonly number[],
  incoming: ReadonlyArray<{ row_num: number; claim: string; kind: string; holder: string }>): Promise<Array<{ preimage: TakePreimage; gone: boolean }>> {
  const rows = await tx.executeRaw<{ preimage: TakePreimage; gone: boolean }>(
    `SELECT jsonb_build_object('id', k.id, 'page_id', k.page_id, 'row_num', k.row_num, 'claim', k.claim, 'kind', k.kind, 'holder', k.holder,
  'weight', k.weight, 'since_date', k.since_date, 'until_date', k.until_date, 'source', k.source, 'superseded_by', k.superseded_by, 'active', k.active,
  'resolved_at', k.resolved_at, 'resolved_outcome', k.resolved_outcome, 'resolved_value', k.resolved_value, 'resolved_unit', k.resolved_unit,
  'resolved_source', k.resolved_source, 'resolved_by', k.resolved_by, 'resolved_quality', k.resolved_quality) AS preimage, k.id = ANY($2::bigint[]) AS gone FROM takes k
      LEFT JOIN jsonb_to_recordset($3::text::jsonb) AS n(row_num integer, claim text, kind text, holder text) ON n.row_num = k.row_num
     WHERE k.page_id = $1 AND (k.id = ANY($2::bigint[]) OR (n.row_num IS NOT NULL AND (k.claim, k.kind, k.holder) IS DISTINCT FROM (n.claim, n.kind, n.holder)))
     ORDER BY k.row_num`, [pageId, [...ids], JSON.stringify(incoming.map(t => ({ row_num: t.row_num, claim: t.claim, kind: t.kind, holder: t.holder })))]);
  return rows.map(r => ({ preimage: r.preimage, gone: r.gone === true }));
}

/** Deletes the takes `ids`, whatever their page, with the synthesis evidence that cites them; an empty list deletes nothing. */
export async function deleteTakesByIds(tx: Raw, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  await tx.executeRaw('DELETE FROM takes WHERE id = ANY($1::bigint[])', [[...ids]]);
}

/** The id of page `pageId`'s take at `rowNum`, or null. */
export async function findTakeId(tx: Raw, pageId: number, rowNum: number): Promise<number | null> {
  const [take] = await tx.executeRaw<{ id: number | string }>('SELECT id FROM takes WHERE page_id=$1 AND row_num=$2', [pageId, rowNum]);
  return take ? Number(take.id) : null;
}

/** The row number and stored `superseded_by` of every take on page `pageId` (the take supersession repair's stored pointers). */
export async function listTakePointers(tx: Raw, pageId: number): Promise<Array<{ row_num: number; superseded_by: number | null }>> {
  return tx.executeRaw<{ row_num: number; superseded_by: number | null }>(
    'SELECT row_num, superseded_by FROM takes WHERE page_id = $1', [pageId]);
}

/**
 * The `old_row` / `new_row` outcome text of the committed `takes_supersede` requests of page `pageId` (or, for a request
 * that recorded no page, of `slug`) in source `sourceId`: the journal evidence of the take supersession repair.
 */
export async function listTakeSupersedeReceipts(tx: Raw, sourceId: string, pageId: number, slug: string): Promise<Array<{ old_row: string | null; new_row: string | null }>> {
  return tx.executeRaw<{ old_row: string | null; new_row: string | null }>(
    `SELECT outcome->>'old_row' AS old_row, outcome->>'new_row' AS new_row FROM persistence_requests
      WHERE operation = 'takes_supersede' AND state = 'committed' AND source_id = $1
        AND (page_id = $2 OR (page_id IS NULL AND slug = $3))`, [sourceId, pageId, slug]);
}

/** Sets the stored `superseded_by` of page `pageId`'s take at `rowNum` (null clears it); nothing else on the row moves. */
export async function setTakeSupersededBy(tx: Raw, pageId: number, rowNum: number, supersededBy: number | null): Promise<void> {
  await tx.executeRaw('UPDATE takes SET superseded_by = $3 WHERE page_id = $1 AND row_num = $2', [pageId, rowNum, supersededBy]);
}

/** One accepted take `forget` proposal with the committed `takes_remove` request that applied it (repair accepted-takes). */
export interface AcceptedTakeRemoval {
  proposal_id: number; source_id: string; slug: string; page_id: number; row_num: number; receipt_id: string; change: string; writer_tier: string;
}

/**
 * The accepted `forget` proposals on takes of the sources (not proposed by `takes_remove`, their change `deactivated` or
 * `replaced`; `proposalId` narrows to one) joined to the committed `takes_remove` request whose intent accepts them, by
 * proposal id.
 */
export async function listAcceptedTakeRemovals(tx: Raw, sourceIds: readonly string[], proposalId: number | null): Promise<AcceptedTakeRemoval[]> {
  return tx.executeRaw<AcceptedTakeRemoval>(`SELECT p.id::int AS proposal_id, r.source_id, r.slug, r.page_id::int AS page_id,
      (r.intent->>'row_num')::int AS row_num, r.id::text AS receipt_id, p.before_state->>'change' AS change,
      p.before_state->>'writer_tier' AS writer_tier
    FROM trust_proposals p
    JOIN persistence_requests r ON r.operation = 'takes_remove' AND r.state = 'committed' AND r.source_id = p.source_id
      AND r.intent->>'trust_accept' = p.id::text AND r.page_id IS NOT NULL AND (r.intent->>'row_num') ~ '^[0-9]+$'
    WHERE p.action = 'forget' AND p.target_table = 'takes' AND p.status = 'accepted' AND p.proposer <> 'takes_remove'
      AND p.before_state->>'change' IN ('deactivated', 'replaced') AND p.source_id = ANY($1::text[])
      AND ($2::bigint IS NULL OR p.id = $2::bigint)
    ORDER BY p.id`, [[...sourceIds], proposalId]);
}

/** The id and stored trust tier of the take in row `rowNum` of page `pageId`, or null. */
export async function readTakeRowTier(tx: Raw, pageId: number, rowNum: number): Promise<{ id: number; trust_tier: string } | null> {
  const [row] = await tx.executeRaw<{ id: number; trust_tier: string }>('SELECT id::int AS id, trust_tier FROM takes WHERE page_id = $1 AND row_num = $2', [pageId, rowNum]);
  return row ?? null;
}

/**
 * The two before-state statements, written out in full (no composition, so each `$n` is a static placeholder);
 * `TAKE_PREIMAGE_SQL` is the column list both carry, pinned byte-for-byte by test/engine-sql-caller-raw-sql-pins.test.ts.
 */
const TAKE_PREIMAGES_SQL = {
  id: `SELECT jsonb_build_object('id', k.id, 'page_id', k.page_id, 'row_num', k.row_num, 'claim', k.claim, 'kind', k.kind, 'holder', k.holder,
  'weight', k.weight, 'since_date', k.since_date, 'until_date', k.until_date, 'source', k.source, 'superseded_by', k.superseded_by, 'active', k.active,
  'resolved_at', k.resolved_at, 'resolved_outcome', k.resolved_outcome, 'resolved_value', k.resolved_value, 'resolved_unit', k.resolved_unit,
  'resolved_source', k.resolved_source, 'resolved_by', k.resolved_by, 'resolved_quality', k.resolved_quality) AS preimage, k.id = ANY($2::bigint[]) AS gone FROM takes k
      LEFT JOIN jsonb_to_recordset($3::text::jsonb) AS n(row_num integer, claim text, kind text, holder text) ON n.row_num = k.row_num
     WHERE k.page_id = $1 AND (k.id = ANY($2::bigint[]) OR (n.row_num IS NOT NULL AND (k.claim, k.kind, k.holder) IS DISTINCT FROM (n.claim, n.kind, n.holder)))
     ORDER BY k.row_num`,
  rowNum: `SELECT jsonb_build_object('id', k.id, 'page_id', k.page_id, 'row_num', k.row_num, 'claim', k.claim, 'kind', k.kind, 'holder', k.holder,
  'weight', k.weight, 'since_date', k.since_date, 'until_date', k.until_date, 'source', k.source, 'superseded_by', k.superseded_by, 'active', k.active,
  'resolved_at', k.resolved_at, 'resolved_outcome', k.resolved_outcome, 'resolved_value', k.resolved_value, 'resolved_unit', k.resolved_unit,
  'resolved_source', k.resolved_source, 'resolved_by', k.resolved_by, 'resolved_quality', k.resolved_quality) AS preimage, k.row_num = ANY($2::integer[]) AS gone FROM takes k
      LEFT JOIN jsonb_to_recordset($3::text::jsonb) AS n(row_num integer, claim text, kind text, holder text) ON n.row_num = k.row_num
     WHERE k.page_id = $1 AND (k.row_num = ANY($2::integer[]) OR (n.row_num IS NOT NULL AND (k.claim, k.kind, k.holder) IS DISTINCT FROM (n.claim, n.kind, n.holder)))
     ORDER BY k.row_num`,
} as const;

/** A take a write is about to put at its row number. */
export interface IncomingTakeRow { row_num: number; claim: string; kind: string; holder: string }

export interface TakePreimageRead {
  pageId: number;
  /** Whether `gone` names takes by id or by row number. */
  by: 'id' | 'row_num';
  /** The takes the write deletes. */
  gone: readonly number[];
  /** The takes the write puts: a stored take at one of their row numbers with another claim, kind or holder is replaced. */
  incoming: readonly IncomingTakeRow[];
}

const INT4_MAX = 2147483647;

function checkTakeInts(what: string, values: readonly number[], max: number): void {
  const bad = values.find(v => !Number.isInteger(v) || Math.abs(v) > max);
  if (bad !== undefined) throw new Error(`readTakePreimages: ${what} must be whole numbers in range: ${JSON.stringify(bad)}`);
}

/** The argument checks both engines and the store apply before the read (the casts Postgres would refuse). */
export function checkTakePreimageRead(read: TakePreimageRead): void {
  checkTakeInts('page ids', [read.pageId], INT4_MAX);
  checkTakeInts(read.by === 'id' ? 'take ids' : 'take row numbers', read.gone, read.by === 'id' ? Number.MAX_SAFE_INTEGER : INT4_MAX);
  checkTakeInts('take row numbers', read.incoming.map(take => take.row_num), INT4_MAX);
}

/**
 * The takes generation adapter's before-state read (generations/adapters/take-rows.ts): the full row of each take of the
 * page that `gone` names (`gone: true`), and of each take an incoming row would replace (`gone: false`), by row number.
 * A take joined by two incoming rows of its number comes back once per row, as the join does.
 */
export async function readTakePreimages(tx: Raw, read: TakePreimageRead): Promise<Array<{ preimage: TakePreimage; gone: boolean }>> {
  checkTakePreimageRead(read);
  if (!read.gone.length && !read.incoming.length) return [];
  const incoming = JSON.stringify(read.incoming.map(take => ({ row_num: take.row_num, claim: take.claim, kind: take.kind, holder: take.holder })));
  if (read.by === 'id') {
    return tx.executeRaw<{ preimage: TakePreimage; gone: boolean }>(
    TAKE_PREIMAGES_SQL.id, [read.pageId, [...read.gone], incoming]);
  }
  return tx.executeRaw<{ preimage: TakePreimage; gone: boolean }>(
    TAKE_PREIMAGES_SQL.rowNum, [read.pageId, [...read.gone], incoming]);
}

/** A resolved take of a holder as the calibration pattern drill-down shows it (`id` is the bigint id as text). */
export interface HolderResolvedTakeRow {
  id: string;
  page_slug: string;
  row_num: number;
  claim: string;
  weight: number;
  resolved_quality: string | null;
  since_date: string | null;
}

/** The drill-down read of `/admin/api/calibration/pattern/:id`, byte for byte as serve-http-admin-api.ts sent it at 0b8fde313c (a tie ends at the lowest take id). */
export const TOP_RESOLVED_TAKES_SQL = `SELECT t.id::text AS id, p.slug AS page_slug, t.row_num, t.claim, t.weight, t.resolved_quality, t.since_date
           FROM takes t JOIN pages p ON p.id = t.page_id
           WHERE t.holder = $1 AND t.active = true AND t.resolved_at IS NOT NULL
           ORDER BY t.weight DESC, t.since_date DESC, t.id
           LIMIT 25`;

/** The holder's 25 heaviest active resolved takes, newest `since_date` first within a weight, then the lowest id, on any page. */
export async function listTopResolvedTakesForHolder(tx: Raw, holder: string): Promise<HolderResolvedTakeRow[]> {
  const rows = await tx.executeRaw<HolderResolvedTakeRow>(TOP_RESOLVED_TAKES_SQL, [holder]);
  return rows.map(r => ({ id: String(r.id), page_slug: r.page_slug, row_num: Number(r.row_num), claim: r.claim, weight: Number(r.weight),
    resolved_quality: r.resolved_quality ?? null, since_date: r.since_date ?? null }));
}

/** An abandoned high-conviction take as the calibration abandoned-threads card shows it. */
export interface AbandonedTakeRow {
  id: number;
  page_slug: string;
  claim: string;
  weight: number;
  since_date: string;
}

/** The abandoned-threads read of `/admin/api/calibration/charts/abandoned-threads`, byte for byte as serve-http-admin-api.ts sent it at 0b8fde313c (a tie ends at the lowest take id). */
export const ABANDONED_TAKES_SQL = `SELECT t.id, p.slug AS page_slug, t.claim, t.weight, t.since_date
             FROM takes t JOIN pages p ON p.id = t.page_id
             WHERE t.active = true AND t.resolved_at IS NULL AND t.superseded_by IS NULL
               AND t.weight >= 0.7
               AND (t.since_date || CASE WHEN length(t.since_date) = 7 THEN '-01' ELSE '' END)::date
                   < (now() - INTERVAL '12 months')
             ORDER BY t.since_date ASC, t.id
             LIMIT 5`;

/**
 * The five oldest active, unresolved, unsuperseded takes of weight 0.7 or more whose `since_date` (a `YYYY-MM` date
 * read as the 1st) is more than 12 months ago, oldest first and then the lowest id, on any page. A `since_date` that is not a date fails the read.
 */
export async function listAbandonedTakes(tx: Raw): Promise<AbandonedTakeRow[]> {
  const rows = await tx.executeRaw<Omit<AbandonedTakeRow, 'id'> & { id: number | string }>(ABANDONED_TAKES_SQL);
  return rows.map(r => ({ id: Number(r.id), page_slug: r.page_slug, claim: r.claim, weight: Number(r.weight), since_date: r.since_date }));
}

/** The take at a page's row number: its id, claim and stored trust tier (the trust reads of the take write gate). */
export async function readTakeRowTrust(tx: Raw, pageId: number, rowNum: number): Promise<{ id: number; claim: string; trust_tier: string } | null> {
  const [row] = await tx.executeRaw<{ id: number | string; claim: string; trust_tier: string }>(
    'SELECT id, claim, trust_tier FROM takes WHERE page_id = $1 AND row_num = $2', [pageId, rowNum]);
  return row ? { id: Number(row.id), claim: row.claim, trust_tier: row.trust_tier } : null;
}

export interface TakeTrustRef {
  id: number;
  /** The source of the take's page. */
  source_id: string;
  claim: string;
  trust_tier: string;
  write_origin: Record<string, unknown> | null;
  active: boolean;
  /** The take's page carries the quarantine frontmatter key. */
  quarantined: boolean;
}

/** A take by id with its page's source and quarantine key, as `gbrain trust explain` reads it. */
export async function readTakeTrustRef(tx: Raw, id: number): Promise<TakeTrustRef | null> {
  const [row] = await tx.executeRaw<Omit<TakeTrustRef, 'id' | 'write_origin'> & { id: number | string; write_origin: unknown }>(
    `SELECT t.id, p.source_id, t.claim, t.trust_tier, t.write_origin, t.active,
            (COALESCE(p.frontmatter, '{}'::jsonb) ? $2::text) AS quarantined
       FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.id = $1`, [id, QUARANTINE_KEY]);
  if (!row) return null;
  const origin = typeof row.write_origin === 'string' ? JSON.parse(row.write_origin) as Record<string, unknown> : (row.write_origin as Record<string, unknown> | null);
  return { id: Number(row.id), source_id: row.source_id, claim: row.claim, trust_tier: row.trust_tier, write_origin: origin ?? null,
    active: !!row.active, quarantined: !!row.quarantined };
}
