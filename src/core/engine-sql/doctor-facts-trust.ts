/**
 * Doctor facts, fence and trust reads: the statements `gbrain doctor` checks (and the readers they share) ran through
 * `executeRaw`, each with the same text and parameters, on the engine's own `executeRaw`; only their home moved.
 * PGLite and Postgres run these exact statements. Each variant is one constant; the connector kind list is the constant
 * CONNECTOR_KIND_LIST_SQL, and the named claim read binds its ids through sqlFragment.
 *
 * The Rust engine answers each member from its store or, where the store keeps no writer of the relation, with the
 * empty value (rust/docs/store/cli-reads-doctor-facts-trust.md).
 */
import { CONNECTOR_KIND_LIST_SQL } from '../persistence/connector-kinds.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/**
 * The members of this file. Each replaced a statement doctor ran through its deadline-bound executeRaw, so
 * src/core/statement-deadline.ts keeps that bound on them (BOUNDED_TYPED_READS).
 */
export const DOCTOR_FACTS_TRUST_MEMBERS: readonly string[] = [
  'countConversationPipelinePages', 'listPersistentWriterContention', 'countRowTrustTiers',
  'countLegacyUnknownBySource', 'listTrustColumns', 'listTrustClaimTargets', 'countClaimLiftedRows',
];

/** A timestamp column as an engine returns it: a Date, or the text a driver without a timestamp codec gives. */
type Stamp = Date | string;

/** One source whose deferred facts writes persist: the count and the oldest write time. */
export interface WriterContentionRow { source_id: string; n: number; oldest: Stamp }

const COUNT_CONVERSATION_PIPELINE_PAGES_SQL = `SELECT count(*)::int AS n FROM pages
      WHERE deleted_at IS NULL AND type = ANY($1::text[]) AND NOT (slug LIKE ANY($2::text[]))`;

/** Live pages of the conversation-pipeline `types` whose slug matches none of the `slugPatterns` (LIKE patterns). */
export async function countConversationPipelinePages(raw: EngineRawRead, types: readonly string[], slugPatterns: readonly string[]): Promise<number> {
  const [row] = await raw<{ n: number }>(COUNT_CONVERSATION_PIPELINE_PAGES_SQL, [types, slugPatterns]);
  return Number(row?.n ?? 0);
}

const LIST_PERSISTENT_WRITER_CONTENTION_SQL = `SELECT l.source_id, COUNT(*)::int AS n, MIN(l.created_at) AS oldest
         FROM ingest_log l
        WHERE l.source_type = 'facts:absorb'
          AND l.created_at >= now() - INTERVAL '24 hours'
          AND split_part(l.summary, ':', 1) = $1
          AND NOT EXISTS (
            SELECT 1 FROM minion_jobs j
             WHERE j.name = 'facts-absorb' AND j.status = 'completed' AND j.finished_at >= l.created_at
               AND j.data->>'slug' = l.source_ref AND COALESCE(j.data->>'sourceId', 'default') = l.source_id)
        GROUP BY l.source_id
       HAVING COUNT(*) > 10 OR MIN(l.created_at) < now() - INTERVAL '1 hour'
        ORDER BY l.source_id COLLATE "C"`;

/**
 * Per source, the facts writes deferred before admission (`reason`) in the last 24 hours that no facts-absorb job for the same
 * page completed after, when they persist: more than 10, or the oldest over an hour old. Throws the missing-table error of
 * `minion_jobs` on a brain without it.
 */
export async function listPersistentWriterContention(raw: EngineRawRead, reason: string): Promise<WriterContentionRow[]> {
  return raw<WriterContentionRow>(LIST_PERSISTENT_WRITER_CONTENTION_SQL, [reason]);
}

/** The tables whose stored tiers `trust_tiers` counts beside the pages (`countPageTrustTiers`). */
export type TrustTierTable = 'facts' | 'takes' | 'timeline_entries';
/** One stored tier and its row count (`tier` is null for a row with no stored tier). */
export interface RowTrustTierCount { tier: string | null; n: number }

const ROW_TRUST_TIERS_SQL = {
  facts: 'SELECT trust_tier AS tier, count(*) AS n FROM facts GROUP BY trust_tier',
  takes: 'SELECT trust_tier AS tier, count(*) AS n FROM takes GROUP BY trust_tier',
  timeline_entries: 'SELECT trust_tier AS tier, count(*) AS n FROM timeline_entries GROUP BY trust_tier',
} as const;

/** Rows of `table` per stored `trust_tier`. */
export async function countRowTrustTiers(raw: EngineRawRead, table: TrustTierTable): Promise<RowTrustTierCount[]> {
  const rows = await raw<{ tier: string | null; n: string | number }>(ROW_TRUST_TIERS_SQL[table]);
  return rows.map((row) => ({ tier: row.tier, n: Number(row.n) }));
}

/** Each table's greatest id when the trust migrations ran (claim-state.ts `LegacyCeilings`), or null: every row is legacy. */
export type LegacyIdCeilings = Partial<Record<'pages' | 'facts' | 'takes' | 'timeline_entries', number>> | null;
/** A source and the rows it holds that are still at `unknown` and legacy. */
export interface LegacyUnknownRow { source_id: string; n: number }

/** The ceiling that admits every id (a bigint cast of this binds on both engines). */
const NO_CEILING = Number.MAX_SAFE_INTEGER;

const COUNT_LEGACY_UNKNOWN_BY_SOURCE_SQL = `SELECT source_id, sum(n)::bigint AS n FROM (
       SELECT p.source_id, count(*) AS n FROM pages p WHERE p.trust_tier = 'unknown' AND p.deleted_at IS NULL AND p.id <= $1::bigint AND ($5::text[] IS NULL OR p.source_id = ANY($5::text[])) GROUP BY 1
       UNION ALL SELECT f.source_id, count(*) FROM facts f WHERE f.trust_tier = 'unknown' AND f.id <= $2::bigint AND ($5::text[] IS NULL OR f.source_id = ANY($5::text[])) GROUP BY 1
       UNION ALL SELECT p.source_id, count(*) FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.trust_tier = 'unknown' AND t.id <= $3::bigint AND ($5::text[] IS NULL OR p.source_id = ANY($5::text[])) GROUP BY 1
       UNION ALL SELECT p.source_id, count(*) FROM timeline_entries te JOIN pages p ON p.id = te.page_id WHERE te.trust_tier = 'unknown' AND te.id <= $4::bigint AND ($5::text[] IS NULL OR p.source_id = ANY($5::text[])) GROUP BY 1
     ) u GROUP BY source_id`;

/** Per source, the legacy rows (id at or below the table's ceiling; every row without ceilings) still at `unknown`, across live pages, facts, takes and timeline entries; only `sourceIds` when given. */
export async function countLegacyUnknownBySource(raw: EngineRawRead, ceilings: LegacyIdCeilings, sourceIds?: readonly string[]): Promise<LegacyUnknownRow[]> {
  const ceiling = (table: 'pages' | 'facts' | 'takes' | 'timeline_entries'): number => (ceilings ? Math.trunc(ceilings[table] ?? 0) : NO_CEILING);
  const rows = await raw<{ source_id: string; n: number | string }>(COUNT_LEGACY_UNKNOWN_BY_SOURCE_SQL,
    [ceiling('pages'), ceiling('facts'), ceiling('takes'), ceiling('timeline_entries'), sourceIds ? [...sourceIds] : null]);
  return rows.map((row) => ({ source_id: row.source_id, n: Number(row.n) }));
}

/** A column of one of the tables the trust backfill classifies. */
export interface TrustColumnRow { table_name: string; column_name: string }

const TRUST_COLUMN_TABLES = ['pages', 'facts', 'takes', 'timeline_entries', 'sources', 'persistence_requests'];

const LIST_TRUST_COLUMNS_SQL = `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`;

/** The columns the trust backfill's classifier may read, of the tables it reads them from. */
export async function listTrustColumns(raw: EngineRawRead): Promise<TrustColumnRow[]> {
  return raw<TrustColumnRow>(LIST_TRUST_COLUMNS_SQL, [TRUST_COLUMN_TABLES]);
}

/** Which sources a claim read looks at: every non-connector source, the named non-connector ones, or the claimed ones. */
export type TrustClaimTargetMode = 'owned' | 'named' | 'claimed';
/** A non-connector source and whether it is claimed. */
export interface TrustClaimTargetRow { id: string; claimed: boolean }

const TRUST_OWNED_SQL = `SELECT s.id, (s.config ? 'trust_claimed_at' AND s.config->>'trust_tier' = 'operator_curated' AND COALESCE(s.config->>'kind', '') NOT IN ${CONNECTOR_KIND_LIST_SQL}) AS claimed FROM sources s WHERE COALESCE(s.config->>'kind', '') NOT IN ${CONNECTOR_KIND_LIST_SQL}`;
const TRUST_CLAIMED_COLUMN_SQL = `(s.config ? 'trust_claimed_at' AND s.config->>'trust_tier' = 'operator_curated' AND COALESCE(s.config->>'kind', '') NOT IN ${CONNECTOR_KIND_LIST_SQL})`;
const TRUST_NOT_CONNECTOR_SQL = `COALESCE(s.config->>'kind', '') NOT IN ${CONNECTOR_KIND_LIST_SQL}`;
function trustNamedStatement(sourceIds: readonly string[]): { text: string; params: unknown[] } {
  return renderFragment(sqlFragment`SELECT s.id, ${trustedSql(TRUST_CLAIMED_COLUMN_SQL)} AS claimed FROM sources s
        WHERE s.id = ANY(${[...sourceIds]}::text[]) AND ${trustedSql(TRUST_NOT_CONNECTOR_SQL)} ORDER BY s.id COLLATE "C"`);
}
const TRUST_CLAIMED_SQL = `SELECT s.id, true AS claimed FROM sources s WHERE (s.config ? 'trust_claimed_at' AND s.config->>'trust_tier' = 'operator_curated' AND COALESCE(s.config->>'kind', '') NOT IN ${CONNECTOR_KIND_LIST_SQL}) ORDER BY s.id COLLATE "C"`;

/** Non-connector sources (`owned`, archived ones too, in no order), the named ones among them (`named`), or the claimed ones (`claimed`), by id; each with whether it is claimed. */
export async function listTrustClaimTargets(raw: EngineRawRead, mode: TrustClaimTargetMode, sourceIds?: readonly string[]): Promise<TrustClaimTargetRow[]> {
  if (mode === 'named') {
    const { text, params } = trustNamedStatement(sourceIds ?? []);
    return raw<TrustClaimTargetRow>(text, params);
  }
  return raw<TrustClaimTargetRow>(mode === 'owned' ? TRUST_OWNED_SQL : TRUST_CLAIMED_SQL);
}

/** The tables a source claim lifts rows of. */
export type ClaimLiftTable = 'pages' | 'facts' | 'takes' | 'timeline_entries';

const CLAIM_LIFTED_SQL = {
  pages: "SELECT count(*) AS n FROM pages WHERE write_origin->>'channel' = 'trust_claim' AND write_origin->'owner_decision' IS NULL",
  facts: "SELECT count(*) AS n FROM facts WHERE write_origin->>'channel' = 'trust_claim' AND write_origin->'owner_decision' IS NULL",
  takes: "SELECT count(*) AS n FROM takes WHERE write_origin->>'channel' = 'trust_claim' AND write_origin->'owner_decision' IS NULL",
  timeline_entries: "SELECT count(*) AS n FROM timeline_entries WHERE write_origin->>'channel' = 'trust_claim' AND write_origin->'owner_decision' IS NULL",
} as const;

/**
 * Rows of `table` a source claim lifted (`write_origin.channel` `trust_claim`) that no owner decision (`trust confirm`,
 * `trust lower`) has settled since, whatever their source: the rows `trust claim-sources --relower` may lower (#10178).
 */
export async function countClaimLiftedRows(raw: EngineRawRead, table: ClaimLiftTable): Promise<number> {
  const [row] = await raw<{ n: number | string }>(CLAIM_LIFTED_SQL[table]);
  return Number(row?.n ?? 0);
}
