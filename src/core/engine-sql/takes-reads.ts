/**
 * The small reads that doctor, onboarding, the fact purge, the fence import, the scorecard's MCP count and the take
 * supersession repair made through `executeRaw`: take counts and rows, the pages whose salience weight lags their
 * takes, and whether a source owns unresolved code edges. SQL once for both engines, so a store that is not SQL
 * serves the same members (rust/docs/store/takes-reads.md).
 *
 * Every function takes the engine (or transaction) it runs on. Counts come back as numbers.
 */
import type { BrainEngine } from '../engine.ts';
import { privatePagesFilterForCaller } from '../search/private-visibility.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

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
  const privacy = spec.excludePrivate ? sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('p'))}` : sqlFragment``;
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
