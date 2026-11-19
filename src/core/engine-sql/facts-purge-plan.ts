/**
 * The reads a fact purge's plan, its dry run and `--match` make (facts/purge.ts planFactPurge, stagingsHoldingClaim and
 * matchCandidates; facts/purge-verify.ts; persistence/intent-redaction.ts findRequestsCarrying and
 * findRequestsHoldingStagings; facts/derivation-inputs.ts derivedRowsFrom). Each function runs the statement its caller
 * ran through `executeRaw`, with the same text and parameters, on the engine's own `executeRaw`; only its home moved.
 * The texts live in facts/purge-plan-statements.ts. The inventory probes (`countPurgeProbe`, `listPurgeProbeItems`)
 * are built there from the deletion inventory's own table and column names; the caller's needles are parameters.
 */
import {
  boundedCountSql, DERIVED_ROWS_STEP_SQL, FACT_NEIGHBOURS_SQL, LEGACY_DERIVED_PAGES_SQL, LIVE_PAGE_SLUG_SQL, PAGE_SOURCE_PATHS_SQL,
  probeItemsSql, PROBE_TIMEOUT_SQL, PURGE_CARRYING_VERSIONS_SQL, PURGE_MATCH_SQL, PURGE_REVIEW_COUNTS_SQL, PURGE_TAKE_PAGES_SQL,
  purgeProbeSelect, REQUESTS_CARRYING_SQL, REQUESTS_HOLDING_STAGINGS_SQL, SEGMENTED_PAGE_BODIES_SQL, SEGMENTED_VERSION_BODIES_SQL,
  STAGING_PART_EDGES_SQL, STAGINGS_HOLDING_CLAIM_SQL, type PurgeProbe,
} from '../facts/purge-plan-statements.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { PurgeProbe } from '../facts/purge-plan-statements.ts';

/** The claim's needles a version or request scan matches: lowercased, JSON-escaped lowercased, and the folded reason. */
export interface PurgeClaimNeedles { sourceId: string; claimLower: string; claimJson: string; reason: string }
/** stagingsHoldingClaim's needles: lowercased, exact, and the lowercased fence cell. */
export interface StagingClaimNeedles { sourceId: string; claimLower: string; claim: string; cellLower: string }
export interface PurgeTakePage { slug: string; page_id: number; revision: string }
export interface StagingPartEdge { id: string; part_no: number; head: Uint8Array; tail: Uint8Array }
export interface PurgeReviewCounts { q: number; rp: number; dp: number }
export interface PurgeMatchRow { id: number; entity_slug: string | null; visibility: string; expired: boolean; fact: string }
export interface PurgeRequestTarget { id: string; principal_kind: string; principal_id: string }
export interface DerivedRowStep { derived_table: string; derived_id: string }
export interface SegmentedPurgeBody { page_id: number; slug: string; generation: number | null; version_id: number | null }
export interface FactNeighbour { id: number; similarity: number; contains_claim: boolean }

/** planFactPurge: whether the source has a live page at `slug`. */
export async function hasLivePageSlug(raw: EngineRawRead, sourceId: string, slug: string): Promise<boolean> {
  return (await raw(LIVE_PAGE_SLUG_SQL, [sourceId, slug])).length > 0;
}

/** planFactPurge: the pages `pageIds` of the source with their knowledge revisions (text). */
export async function readPurgeTakePages(raw: EngineRawRead, sourceId: string, pageIds: readonly number[]): Promise<PurgeTakePage[]> {
  return raw<PurgeTakePage>(PURGE_TAKE_PAGES_SQL, [sourceId, [...pageIds]]);
}

/** planFactPurge: the source's page versions that carry the claim. */
export async function countPurgeCarryingVersions(raw: EngineRawRead, q: PurgeClaimNeedles): Promise<number> {
  const [row] = await raw<{ n: number }>(PURGE_CARRYING_VERSIONS_SQL, [q.sourceId, q.claimLower, q.claimJson, q.reason]);
  return Number(row?.n ?? 0);
}

/** stagingsHoldingClaim: the live stagings of the source that hold the claim in one part, by id. */
export async function listStagingsHoldingClaim(raw: EngineRawRead, q: StagingClaimNeedles): Promise<string[]> {
  return (await raw<{ id: string }>(STAGINGS_HOLDING_CLAIM_SQL, [q.sourceId, q.claimLower, q.claim, q.cellLower])).map(row => row.id);
}

/** stagingsWithClaimAcrossParts: the next batch of live staging parts after (`afterId`, `afterPart`), `keep` bytes each end. */
export async function readStagingPartEdges(raw: EngineRawRead, sourceId: string, keep: number, afterId: string, afterPart: number): Promise<StagingPartEdge[]> {
  return raw<StagingPartEdge>(STAGING_PART_EDGES_SQL, [sourceId, keep, afterId, afterPart]);
}

/** planFactPurge: the review rows naming the purged facts. */
export async function countPurgeReviewRows(raw: EngineRawRead, sourceId: string, factIds: readonly number[]): Promise<PurgeReviewCounts> {
  const [row] = await raw<PurgeReviewCounts>(PURGE_REVIEW_COUNTS_SQL, [sourceId, factIds.map(String), [...factIds]]);
  return { q: Number(row?.q ?? 0), rp: Number(row?.rp ?? 0), dp: Number(row?.dp ?? 0) };
}

/** `--match`: up to 25 facts of the source whose text contains `text`. */
export async function matchPurgeCandidates(raw: EngineRawRead, sourceId: string, text: string): Promise<PurgeMatchRow[]> {
  return raw<PurgeMatchRow>(PURGE_MATCH_SQL, [sourceId, text]);
}

/** findRequestsCarrying: the source's requests whose stored text carries the claim, up to `limit`. */
export async function listRequestsCarryingClaim(raw: EngineRawRead, q: PurgeClaimNeedles & { limit: number }): Promise<PurgeRequestTarget[]> {
  return raw<PurgeRequestTarget>(REQUESTS_CARRYING_SQL, [q.sourceId, q.claimLower, q.claimJson, q.reason, q.limit]);
}

/** findRequestsHoldingStagings: the source's unfinished requests that publish one of `stagingIds`. */
export async function listRequestsHoldingStagings(raw: EngineRawRead, sourceId: string, stagingIds: readonly string[]): Promise<PurgeRequestTarget[]> {
  return raw<PurgeRequestTarget>(REQUESTS_HOLDING_STAGINGS_SQL, [sourceId, [...stagingIds]]);
}

/** derivedRowsFrom: one hop of the walk, the rows derived from `frontier`, up to `limit`. */
export async function listDerivedRowsStep(raw: EngineRawRead, frontier: ReadonlyArray<{ table: string; id: string }>, limit: number): Promise<DerivedRowStep[]> {
  return raw<DerivedRowStep>(DERIVED_ROWS_STEP_SQL, [JSON.stringify(frontier.map(f => ({ input_table: f.table, input_id: f.id }))), limit]);
}

/** segmentedProse: the source's segmented live pages or page versions, up to `limit`. */
export async function listSegmentedPurgeBodies(raw: EngineRawRead, sourceId: string, store: 'pages' | 'page_versions', limit: number): Promise<SegmentedPurgeBody[]> {
  return raw<SegmentedPurgeBody>(store === 'pages' ? SEGMENTED_PAGE_BODIES_SQL : SEGMENTED_VERSION_BODIES_SQL, [sourceId, limit]);
}

/** verifyFactPurge: the source's live model-derived pages with no derivation edge. */
export async function countLegacyDerivedPages(raw: EngineRawRead, sourceId: string): Promise<number> {
  const [row] = await raw<{ n: number }>(LEGACY_DERIVED_PAGES_SQL, [sourceId]);
  return Number(row?.n ?? 0);
}

/** pageFilePaths: the relative file paths the pages and their versions recorded. */
export async function listPageSourcePaths(raw: EngineRawRead, pageIds: readonly number[]): Promise<string[]> {
  return (await raw<{ source_path: string }>(PAGE_SOURCE_PATHS_SQL, [[...pageIds]])).map(row => row.source_path);
}

/** vectorProbe: the five same-model facts of the source nearest `embedding`. */
export async function listFactNeighbours(raw: EngineRawRead, q: { embedding: string; sourceId: string; model: string; claim: string }): Promise<FactNeighbour[]> {
  return raw<FactNeighbour>(FACT_NEIGHBOURS_SQL, [q.embedding, q.sourceId, q.model, q.claim]);
}

/** boundedCount: the transaction-local statement deadline of the next probe. */
export async function setPurgeProbeTimeout(raw: EngineRawRead, statementMs: number): Promise<void> {
  await raw(PROBE_TIMEOUT_SQL, [`${statementMs}ms`]);
}

/** boundedCount: the rows `probe` finds, at most `rows + 1`. */
export async function countPurgeProbe(raw: EngineRawRead, probe: PurgeProbe, rows: number): Promise<number> {
  const select = purgeProbeSelect(probe);
  if (!select) return 0;
  const [row] = await raw<{ n: number }>(boundedCountSql(select.sql, rows), select.params);
  return Number(row?.n ?? 0);
}

/** probeNamedRows: the first 20 rows a named probe lists. */
export async function listPurgeProbeItems(raw: EngineRawRead, probe: PurgeProbe & { kind: 'named' }): Promise<string[]> {
  const select = purgeProbeSelect(probe);
  if (!select) return [];
  return (await raw<{ item: string }>(probeItemsSql(select.sql), select.params)).map(row => row.item);
}
