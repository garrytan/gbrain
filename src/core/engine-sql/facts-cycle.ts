/**
 * Group 5 facts statements, command, cycle and fence reads (docs/research/rust-cli-contract-map.md, "Facts queries, purge and unlinked-fact
 * checks"). Each function runs the statement its caller ran through `executeRaw`, with the same text and parameters, on
 * the engine's own `executeRaw`; only its home moved.
 */
import { readersSourcedFactSql } from '../access/member-facts.ts';
import { projectionEligibleSql } from '../eligibility/sql.ts';
import type { ReadEligibility } from '../eligibility/policy.ts';
import { privateFactFilterForReader } from '../search/private-visibility.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
export type { EngineRawRead } from './cli-reads-ops.ts';

/** enrich evidence: one active fact about an entity, as `listActiveFactsForEntity` returns it. */
export interface EvidenceFactRow { fact: string; context: string | null }

/**
 * enrich's grounding read: the entity's unexpired facts that have not lapsed, highest confidence first (newest id breaks
 * a tie), at most `limit`.
 */
export async function listActiveFactsForEntity(raw: EngineRawRead, sourceId: string, entitySlug: string, limit: number): Promise<EvidenceFactRow[]> {
  return raw<EvidenceFactRow>(
    `SELECT fact, context FROM facts
        WHERE source_id = $1 AND entity_slug = $2 AND expired_at IS NULL
          AND (valid_until IS NULL OR valid_until > now())
        ORDER BY confidence DESC, id DESC
        LIMIT $3`,
    [sourceId, entitySlug, limit],
  );
}

/** One unexpired audit row of a page: which audit source wrote it and the session that names the page version. */
export interface ExtractionOutcomeRow { slug: string; source: string; source_session: string | null }

/**
 * extract-conversation-facts' durable outcomes: the unexpired audit rows of `slugs` written by one of `sources`, by page
 * slug, the rows of `preferredSource` first within a page.
 */
export async function listFreshExtractionOutcomes(raw: EngineRawRead, sourceId: string, slugs: string[], sources: string[], preferredSource: string): Promise<ExtractionOutcomeRow[]> {
  return raw<ExtractionOutcomeRow>(
    `SELECT source_markdown_slug AS slug, source, source_session
       FROM facts
      WHERE source_id = $1
        AND source_markdown_slug = ANY($2::text[])
        AND source = ANY($3::text[]) AND expired_at IS NULL
      ORDER BY source_markdown_slug,
        CASE WHEN source = $4 THEN 0 ELSE 1 END`,
    [sourceId, slugs, sources, preferredSource],
  );
}

/** The fence row numbers of one page coordinate. */
export interface FenceRowGroupRow { source_id: string; source_markdown_slug: string; row_nums: number[]; all_expired: boolean }

/**
 * The v0.32.2 verify read: every page coordinate with fenced rows (a row number, not a conversation-miner `cli:` row),
 * its row numbers in order and whether every one is expired. No ORDER BY: the groups come back in no set order.
 */
export async function listFenceRowGroups(raw: EngineRawRead): Promise<FenceRowGroupRow[]> {
  return raw<FenceRowGroupRow>(
    `SELECT source_id, source_markdown_slug, array_agg(row_num ORDER BY row_num) AS row_nums,
              bool_and(expired_at IS NOT NULL) AS all_expired
         FROM facts
        WHERE row_num IS NOT NULL
          AND COALESCE(source, '') NOT LIKE 'cli:%'
        GROUP BY source_id, source_markdown_slug`,
  );
}

/** The source and page slug a fact row sits on (its provenance page, else its entity). */
export interface FactSubjectRow { source_id: string; slug: string | null }

/** purge's owner release: the source and page slug of fact `id`, or null when no such row. */
export async function readFactSubject(raw: EngineRawRead, id: number): Promise<FactSubjectRow | null> {
  const [row] = await raw<FactSubjectRow>('SELECT source_id, COALESCE(source_markdown_slug, entity_slug) AS slug FROM facts WHERE id = $1', [id]);
  return row ?? null;
}

/** One fence-owned fact row of a page as extract_facts reconciles it. */
export interface PageFactRow {
  id: number | string;
  fact: string;
  source: string | null;
  row_num: number | string | null;
  superseded_by: number | string | null;
  expired_at: Date | string | null;
  kind: string;
  visibility: string;
  notability: string;
  context: string | null;
  valid_from: Date | string | null;
  valid_until: Date | string | null;
  confidence: number | string;
  claim_metric: string | null;
  claim_value: number | string | null;
  claim_unit: string | null;
  claim_period: string | null;
  has_embedding: boolean;
}

/**
 * extract_facts' stored side of a reconcile: the fence-owned rows of one page coordinate, by row number (rows with no
 * row number last) then id. A `cli:` conversation row and a soft-expired legacy row (no row number) are not fence-owned.
 */
export async function listFactsForPage(raw: EngineRawRead, sourceId: string, slug: string): Promise<PageFactRow[]> {
  return raw<PageFactRow>(
    `SELECT id, fact, source, row_num, superseded_by, expired_at, kind, visibility, notability, context,
            valid_from, valid_until, confidence, claim_metric, claim_value, claim_unit, claim_period,
            embedding IS NOT NULL AS has_embedding
       FROM facts
      WHERE source_id = $1
        AND source_markdown_slug = $2
        AND COALESCE(source, '') NOT LIKE 'cli:%'
        AND NOT (row_num IS NULL AND expired_at IS NOT NULL)
      ORDER BY row_num ASC, id ASC`,
    [sourceId, slug],
  );
}

/** The unfenced active rows of one entity page (`n` is a bigint count: a number on PGLite, text on Postgres). */
export interface LegacyPendingRow { entity_slug: string; n: number | string }

/**
 * extract_facts' empty-fence guard: per entity page of the source, the active unfenced rows (no row number, not an ontology
 * observation) of a live page in a source with a checkout. No ORDER BY.
 */
export async function countLegacyFactsPending(raw: EngineRawRead, sourceId: string): Promise<LegacyPendingRow[]> {
  return raw<LegacyPendingRow>(
    `SELECT f.entity_slug, COUNT(*) AS n
       FROM facts f
      WHERE f.source_id = $1
        AND f.row_num IS NULL
        AND f.dimension IS NULL
        AND f.entity_slug IS NOT NULL
        AND f.expired_at IS NULL
        AND EXISTS (
          SELECT 1 FROM pages p
           WHERE p.source_id = f.source_id
             AND p.slug = f.entity_slug
             AND p.deleted_at IS NULL
        )
        AND EXISTS (
          SELECT 1 FROM sources s
           WHERE s.id = f.source_id
             AND s.local_path IS NOT NULL
        )
      GROUP BY f.entity_slug`,
    [sourceId],
  );
}

/** One (source, entity) bucket of unconsolidated facts. */
export interface UnconsolidatedBucketRow { source_id: string; entity_slug: string; count: number }

/**
 * The consolidate phase's buckets: per (source, entity) the active unconsolidated facts of a live entity page that name no
 * attribution but the user and whose source page names no readers, for buckets of at least `minPerBucket`. `sourceId`
 * narrows to one source; `worldOnly` (a managed brain) keeps world facts. No ORDER BY.
 */
export async function countUnconsolidatedFactsBySource(raw: EngineRawRead, opts: { sourceId?: string; worldOnly: boolean; minPerBucket: number }): Promise<UnconsolidatedBucketRow[]> {
  const { text, params } = renderFragment(sqlFragment`
      SELECT source_id, entity_slug, COUNT(*)::int AS count
      FROM facts
      WHERE consolidated_at IS NULL
        AND expired_at IS NULL
        AND (valid_until IS NULL OR valid_until > now())
        AND entity_slug IS NOT NULL
        AND EXISTS (SELECT 1 FROM pages bucket_page WHERE bucket_page.source_id = facts.source_id AND bucket_page.slug = facts.entity_slug AND bucket_page.deleted_at IS NULL)
        AND (attributed_to IS NULL OR attributed_to = 'user')
        AND (${opts.worldOnly}::boolean=false OR visibility='world')
        AND (${opts.sourceId ?? null}::text IS NULL OR source_id=${opts.sourceId ?? null}) AND NOT ${trustedSql(readersSourcedFactSql('facts'))}
      GROUP BY source_id, entity_slug
      HAVING COUNT(*) >= ${opts.minPerBucket}
    `);
  return raw<UnconsolidatedBucketRow>(text, params);
}

/** #7247 bulk-day thresholds: the least facts, the least share of the source's active facts and the least distinct entities. */
export interface BulkDayRule { min_facts: number; min_share: number; min_entities: number }

/** One bulk day as the statement returns it (the counts are numbers on PGLite, text on Postgres). */
export interface BulkDayRow {
  source_id: string;
  day: string;
  facts: number | string;
  entities: number | string;
  source_facts: number | string;
  top_sources: Array<{ source: string; facts: number | string }> | string | null;
  dated_claims: number | string;
}

/** How many source tags a bulk day reports, most frequent first. */
export const TOP_SOURCES = 5;

/** The claim's only date token: a YYYY-MM-DD not adjacent to another digit. */
export const DATE_TOKEN = '(^|[^0-9])([0-9]{4}-[0-9]{2}-[0-9]{2})(?![0-9])';
/** The earliest day a claim date can name. */
export const EARLIEST = '1900-01-01';

/** SQL truth of claimDate(claim, day) returning a date, for a text expression claim and a date expression day. */
function claimDateSql(claim: string, day: string): string {
  const d = 'x.dates[1]';
  return `(SELECT CASE WHEN cardinality(x.dates) = 1 AND ${d} >= '${EARLIEST}' AND ${d} < to_char(${day}, 'YYYY-MM-DD')
                          AND substr(${d}, 6, 2) BETWEEN '01' AND '12' AND substr(${d}, 9, 2) BETWEEN '01' AND '31'
                     THEN to_char(make_date(substr(${d}, 1, 4)::int, substr(${d}, 6, 2)::int, 1) + (substr(${d}, 9, 2)::int - 1), 'YYYY-MM-DD') = ${d}
                     ELSE false END
               FROM (SELECT array_agg(m[2]) AS dates FROM regexp_matches(${claim}, '${DATE_TOKEN}', 'g') AS m) x)`;
}

/**
 * Every bulk day of the unarchived sources (`sourceIds` narrows them) under `rule`, in (source, day) order: one read-only
 * aggregate over the sources' unexpired facts, with each day's top source tags and its facts that state their own earlier date.
 */
export async function findBulkFactDays(raw: EngineRawRead, sourceIds: string[] | undefined, rule: BulkDayRule): Promise<BulkDayRow[]> {
  const { text, params } = renderFragment(sqlFragment`
    WITH active AS MATERIALIZED (
      SELECT f.source_id, f.entity_slug, f.source, f.fact, (f.valid_from AT TIME ZONE 'UTC')::date AS day
        FROM facts f
       WHERE f.expired_at IS NULL
         AND f.source_id IN (SELECT id FROM sources WHERE archived IS NOT TRUE AND (${sourceIds ?? null}::text[] IS NULL OR id = ANY(${sourceIds ?? null}::text[])))
    ), totals AS (
      SELECT source_id, count(*) AS n FROM active GROUP BY source_id
    ), bulk AS (
      SELECT a.source_id, a.day, count(*) AS n, count(DISTINCT a.entity_slug) AS entities, t.n AS source_facts
        FROM active a JOIN totals t ON t.source_id = a.source_id
       GROUP BY a.source_id, a.day, t.n
      HAVING count(*) >= ${rule.min_facts}::int AND count(*) >= t.n * ${rule.min_share}::float8 AND count(DISTINCT a.entity_slug) >= ${rule.min_entities}::int
    )
    SELECT b.source_id, to_char(b.day, 'YYYY-MM-DD') AS day, b.n::int AS facts, b.entities::int AS entities, b.source_facts::int AS source_facts,
           (SELECT json_agg(json_build_object('source', s.source, 'facts', s.n) ORDER BY s.n DESC, s.source)
              FROM (SELECT a.source, count(*)::int AS n FROM active a WHERE a.source_id = b.source_id AND a.day = b.day
                     GROUP BY a.source ORDER BY count(*) DESC, a.source LIMIT ${TOP_SOURCES}) s) AS top_sources,
           (SELECT count(*)::int FROM active a WHERE a.source_id = b.source_id AND a.day = b.day AND ${trustedSql(claimDateSql('a.fact', 'b.day'))}) AS dated_claims
      FROM bulk b
     ORDER BY b.source_id, b.day`);
  return raw<BulkDayRow>(text, params);
}

/** A fenced append's next row number: the largest row number a page coordinate's facts hold, 0 for none. */
export async function maxFenceRowNum(raw: EngineRawRead, sourceId: string, slug: string): Promise<number> {
  const [row] = await raw<{ n: number }>('SELECT COALESCE(MAX(row_num),0)::int AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [sourceId, slug]);
  return row?.n ?? 0;
}

/** The id of the facts row that holds `rowNum` at a page coordinate (the oldest when several do), or null for none. */
export async function readFenceRowOccupant(raw: EngineRawRead, sourceId: string, slug: string, rowNum: number): Promise<number | null> {
  const [row] = await raw<{ id: number | string }>(
    'SELECT facts.id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num=$3 ORDER BY facts.id LIMIT 1', [sourceId, slug, rowNum]);
  return row ? Number(row.id) : null;
}

/** One stored fence fact of a page: its row number and claim. */
export interface StoredFenceFactRow { row_num: number; fact: string }

/** The fence repair's prior-aware renumbering input: the page coordinate's facts that hold a row number, oldest id first. */
export async function listStoredFenceFactRows(raw: EngineRawRead, sourceId: string, slug: string): Promise<StoredFenceFactRow[]> {
  return raw<StoredFenceFactRow>(
    'SELECT row_num, fact FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL ORDER BY id', [sourceId, slug]);
}

/** What `countWorldFacts` counts: the entity-card payload's predicate. */
export interface EntityFactCountOpts {
  sourceId: string;
  entitySlugs: string[];
  /** Keep world facts only (a remote card). */
  worldOnly: boolean;
  /** Drop facts the caller may not read (a private-provenance page), by `privateFactFilterForReader`. */
  excludePrivate: boolean;
  eligibility?: ReadEligibility;
}

/**
 * The entity card's exact active-fact count: facts of the named entity slugs in one source that are unexpired (a lapsed
 * `valid_until` still counts), under the card's visibility, privacy and read eligibility.
 */
export async function countWorldFacts(raw: EngineRawRead, opts: EntityFactCountOpts): Promise<number> {
  const visibility = trustedSql(opts.worldOnly ? ` AND visibility = 'world'` : '');
  const privacy = opts.excludePrivate ? trustedSql(` AND ${privateFactFilterForReader('facts')}`) : trustedSql('');
  const { text, params } = renderFragment(sqlFragment`SELECT COUNT(*) AS n
           FROM facts
          WHERE source_id = ${opts.sourceId} AND entity_slug = ANY(${opts.entitySlugs}::text[])
            AND expired_at IS NULL${visibility}${privacy}
            AND ${trustedSql(projectionEligibleSql('facts', 'facts', opts.eligibility))}`);
  const rows = await raw<{ n: string | number }>(text, params);
  return Number(rows[0]?.n ?? 0);
}
