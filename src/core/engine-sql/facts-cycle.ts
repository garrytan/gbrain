/**
 * Group 5 facts statements, command, cycle and fence reads (docs/research/rust-cli-contract-map.md, "Facts queries, purge and unlinked-fact
 * checks"). Each function runs the statement its caller ran through `executeRaw`, with the same text and parameters, on
 * the engine's own `executeRaw`; only its home moved.
 */
import type { FactAttribution } from '../facts-fence.ts';
import type { BodyStorage } from '../page-body/types.ts';
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
  // The slug order never reaches output: the caller keeps the first row per slug in a Map, and the CASE alone ranks the rows of one slug.
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

/**
 * recall's name-and-topic split (#4828): whether some fact of `sourceId` is keyed under a slug with a segment that is a
 * listed token or starts with it and a hyphen, or some page alias of the source is a listed alias. Tokens are slugify
 * output (`[a-z0-9-]`), so they carry no regex metacharacters.
 */
export async function factsOrAliasesMayMatch(raw: EngineRawRead, sourceId: string, slugTokens: readonly string[], aliasNorms: readonly string[]): Promise<boolean> {
  if (slugTokens.length === 0 && aliasNorms.length === 0) return false;
  const rows = await raw<{ hit: number }>(
    `SELECT 1 AS hit FROM facts WHERE source_id = $1 AND entity_slug ~ ANY($2::text[])
     UNION ALL SELECT 1 AS hit FROM page_aliases WHERE source_id = $1 AND alias_norm = ANY($3::text[])
     LIMIT 1`,
    [sourceId, slugTokens.map(t => `(^|/)${t}(-|$)`), [...aliasNorms]]);
  return rows.length > 0;
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
           (SELECT json_agg(json_build_object('source', s.source, 'facts', s.n) ORDER BY s.n DESC, s.source COLLATE "C")
              FROM (SELECT a.source, count(*)::int AS n FROM active a WHERE a.source_id = b.source_id AND a.day = b.day
                     GROUP BY a.source ORDER BY count(*) DESC, a.source COLLATE "C" LIMIT ${TOP_SOURCES}) s) AS top_sources,
           (SELECT count(*)::int FROM active a WHERE a.source_id = b.source_id AND a.day = b.day AND ${trustedSql(claimDateSql('a.fact', 'b.day'))}) AS dated_claims
      FROM bulk b
     ORDER BY b.source_id COLLATE "C", b.day`);
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

// ---- Facts cycle, phantom redirect, fence and file-guard statements (Rust engine lane 4, item 4.2) ----
// Each function below runs the statement its caller ran through `executeRaw` at 5e22f0c134, with the same text and
// parameters; test/facts-cycle-sites-sql-pin.test.ts pins both. Callers keep their own coercions and ordering.

/** A fact row of a page coordinate with its fence row number (null: not in the fence). */
export interface PhantomFactRow { id: number; row_num: number | null }

/** Every facts row of a page coordinate (the phantom's rows to move), with its row number, no set order. */
export async function listPhantomFactRows(raw: EngineRawRead, sourceId: string, slug: string): Promise<PhantomFactRow[]> {
  return raw<PhantomFactRow>(
    'SELECT id, row_num FROM facts WHERE source_id = $1 AND source_markdown_slug = $2',
    [sourceId, slug],
  );
}

/** The fence row numbers a page coordinate's facts already hold (no set order). */
export async function listCanonicalFenceRowNums(raw: EngineRawRead, sourceId: string, slug: string): Promise<Array<{ row_num: number }>> {
  return raw<{ row_num: number }>(
    'SELECT row_num FROM facts WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num IS NOT NULL',
    [sourceId, slug],
  );
}

/**
 * Points fact `id` at page `slug` (entity and fence page) under `rowNum`; a null `rowNum` leaves it with no fence row and
 * expires it if it was not already expired.
 */
export async function moveFactToPage(raw: EngineRawRead, sourceId: string, id: number, slug: string, rowNum: number | null): Promise<void> {
  await raw(
    `UPDATE facts SET entity_slug = $3, source_markdown_slug = $3, row_num = $4::integer,
          expired_at = CASE WHEN $4::integer IS NULL THEN COALESCE(expired_at, now()) ELSE expired_at END
        WHERE id = $1 AND source_id = $2`,
    [id, sourceId, slug, rowNum ?? null],
  );
}

/** Moves the links that point at `phantomId` onto `canonicalId`, skipping any the canonical page already has. */
export async function repointInboundLinks(raw: EngineRawRead, phantomId: number, canonicalId: number): Promise<void> {
  await raw(
    `UPDATE links l SET to_page_id = $2
      WHERE l.to_page_id = $1 AND l.from_page_id <> $2
        AND NOT EXISTS (SELECT 1 FROM links d
          WHERE d.from_page_id = l.from_page_id AND d.to_page_id = $2 AND d.link_type = l.link_type
            AND d.link_source IS NOT DISTINCT FROM l.link_source
            AND d.origin_page_id IS NOT DISTINCT FROM l.origin_page_id)`,
    [phantomId, canonicalId],
  );
}

/** Moves the links that start at `phantomId` onto `canonicalId`, skipping any the canonical page already has. */
export async function repointOutboundLinks(raw: EngineRawRead, phantomId: number, canonicalId: number): Promise<void> {
  await raw(
    `UPDATE links l SET from_page_id = $2
      WHERE l.from_page_id = $1 AND l.to_page_id <> $2
        AND NOT EXISTS (SELECT 1 FROM links d
          WHERE d.from_page_id = $2 AND d.to_page_id = l.to_page_id AND d.link_type = l.link_type
            AND d.link_source IS NOT DISTINCT FROM l.link_source
            AND d.origin_page_id IS NOT DISTINCT FROM l.origin_page_id)`,
    [phantomId, canonicalId],
  );
}

/** Whether page `pageId` (null: no page) has at least one timeline entry. */
export async function pageHasTimelineEntries(raw: EngineRawRead, pageId: number | string | null): Promise<boolean> {
  return (await raw('SELECT 1 FROM timeline_entries WHERE page_id=$1 LIMIT 1', [pageId])).length > 0;
}

/** The largest fence `row_num` of a page coordinate's facts, 0 for none (the phantom redirect's canonical-page read). */
export async function maxFenceRowNumOfPage(raw: EngineRawRead, sourceId: string, slug: string): Promise<number> {
  const [row] = await raw<{ n: number | string | null }>(
    'SELECT MAX(row_num) AS n FROM facts WHERE source_id = $1 AND source_markdown_slug = $2',
    [sourceId, slug],
  );
  return Number(row?.n ?? 0);
}

/**
 * The next page of the source's live root-level slugs (no `/`) past `after`, in slug order, leaving out `held`: at most
 * `take` rows (the caller passes its page size plus one to learn whether more remain).
 */
export async function listRootPageSlugsAfter(raw: EngineRawRead, sourceId: string, take: number, held: string[], after: string): Promise<Array<{ slug: string }>> {
  return raw<{ slug: string }>(
    `SELECT slug FROM pages
       WHERE source_id = $1
         AND deleted_at IS NULL
         AND slug NOT LIKE '%/%'
         AND slug <> ALL($3::text[])
         AND slug COLLATE "C" > $4
       ORDER BY slug COLLATE "C" ASC
       LIMIT $2`,
    [sourceId, take, held, after],
  );
}

/** The ids of the links `pageId` itself owns (not derived from another page). */
export async function listOwnLinkIds(raw: EngineRawRead, pageId: number | string): Promise<Array<{ id: number }>> {
  return raw<{ id: number }>('SELECT id FROM links WHERE from_page_id = $1 AND origin_page_id IS NULL', [pageId]);
}

/** The ids of a page coordinate's unexpired facts. */
export async function listActiveFactIdsOfPage(raw: EngineRawRead, sourceId: string, slug: string): Promise<Array<{ id: number }>> {
  return raw<{ id: number }>('SELECT id FROM facts WHERE source_id = $1 AND source_markdown_slug = $2 AND expired_at IS NULL', [sourceId, slug]);
}

/** Which of facts `ids` are unexpired and now sit on page `slug`. */
export async function listFactIdsStillOnPage(raw: EngineRawRead, ids: number[], slug: string): Promise<Array<{ id: number }>> {
  return raw<{ id: number }>(
    'SELECT id FROM facts WHERE id = ANY($1::bigint[]) AND source_markdown_slug = $2 AND expired_at IS NULL',
    [ids, slug]);
}

/** Which of links `ids` now start at page `pageId`. */
export async function listLinkIdsOnPage(raw: EngineRawRead, ids: number[], pageId: number | string): Promise<Array<{ id: number }>> {
  return raw<{ id: number }>('SELECT id FROM links WHERE id = ANY($1::int[]) AND from_page_id = $2', [ids, pageId]);
}

/** Where a live page says its file came from. */
export interface PageFileOrigin { source_path: string | null; source_uri: string | null }

const PAGE_FILE_ORIGIN_ANY = 'SELECT source_path, source_uri FROM pages WHERE source_id=$1 AND slug=$2';
const PAGE_FILE_ORIGIN_LIVE = PAGE_FILE_ORIGIN_ANY + ' AND deleted_at IS NULL';
/** The recorded file origin (`source_path`, `source_uri`) of a live page, or null for no live page; with `includeDeleted`, a soft-deleted page counts too. */
export async function readPageFileOrigin(raw: EngineRawRead, sourceId: string, slug: string, opts: { includeDeleted?: boolean } = {}): Promise<PageFileOrigin | null> {
  const [page] = await raw<PageFileOrigin>(opts.includeDeleted ? PAGE_FILE_ORIGIN_ANY : PAGE_FILE_ORIGIN_LIVE, [sourceId, slug]);
  return page ?? null;
}

/** One fence row a page coordinate's facts hold, with its claim and source. */
export interface FenceRowClaim { row_num: number; fact: string; source: string | null }

/** The facts of a page coordinate that hold a fence row number, with their claim text and source (no set order). */
export async function listFenceRowClaims(raw: EngineRawRead, sourceId: string, slug: string): Promise<FenceRowClaim[]> {
  return raw<FenceRowClaim>(
    `SELECT row_num, fact, source FROM facts
      WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num IS NOT NULL`,
    [sourceId, slug],
  );
}

/** Gives unfenced fact `id` fence row `rowNum` on page `slug` with claim text `fact`; only a row that still has no fence row changes. */
export async function adoptFactIntoFence(raw: EngineRawRead, sourceId: string, id: string, rowNum: number, slug: string, fact: string): Promise<void> {
  await raw(
    `UPDATE facts SET row_num = $1, source_markdown_slug = $2, fact = $5
            WHERE id = $3 AND source_id = $4 AND row_num IS NULL`,
    [rowNum, slug, id, sourceId, fact],
  );
}

/** A fenced fact row's strike and supersession state. */
export interface FenceRowSupersession { id: number | string; row_num: number | string; expired_at: Date | string | null; superseded_by: number | string | null }

/** The facts of a page coordinate that hold a fence row number, with their expiry and supersession (no set order). */
export async function listFenceRowSupersession(raw: EngineRawRead, sourceId: string, slug: string): Promise<FenceRowSupersession[]> {
  return raw<FenceRowSupersession>(
    `SELECT id, row_num, expired_at, superseded_by FROM facts
      WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num IS NOT NULL`,
    [sourceId, slug],
  );
}

/** Sets (or, with null, clears) fact `id`'s `superseded_by`. */
export async function setFactSupersededBy(raw: EngineRawRead, sourceId: string, id: number | string, supersededBy: number | null): Promise<void> {
  await raw('UPDATE facts SET superseded_by = $1 WHERE id = $2 AND source_id = $3', [supersededBy, id, sourceId]);
}

/** Which of facts `ids` have a pending, rejected or undone trust proposal that holds back a visibility change. */
export async function listHeldWideningFactIds(raw: EngineRawRead, sourceId: string, ids: number[]): Promise<Array<{ id: number }>> {
  return raw<{ id: number }>(
    `SELECT related_id AS id FROM trust_proposals WHERE source_id = $1 AND action IN ('supersede_fact', 'confirm') AND related_table = 'facts'
      AND related_id = ANY($2::bigint[]) AND status IN ('pending', 'rejected', 'undone') AND before_state->'visibility' IS NOT NULL`,
    [sourceId, ids]);
}

/** Expires fact `id` where it stands (the fence row keeps its number). An already expired fact keeps its expiry time. */
export async function expireFactInPlace(raw: EngineRawRead, sourceId: string, id: number | string): Promise<void> {
  await raw('UPDATE facts SET expired_at = COALESCE(expired_at, now()) WHERE id = $1 AND source_id = $2', [id, sourceId]);
}

/** Expires fact `id` and drops its fence row number. An already expired fact keeps its expiry time. */
export async function expireAndDetachFact(raw: EngineRawRead, sourceId: string, id: number | string): Promise<void> {
  await raw(
    `UPDATE facts SET expired_at = COALESCE(expired_at, now()), row_num = NULL
        WHERE id = $1 AND source_id = $2`,
    [id, sourceId],
  );
}

/** The cells a fence row writes onto its fact, after the caller applied each default (the statement binds them as given). */
export interface FenceFactCells {
  kind: string; visibility: string; notability: string; context: string | null;
  /** ISO time, or null to keep the stored `valid_from`. */
  validFrom: string | null;
  /** Whether `validUntil` is written (true) or the stored `valid_until` is kept. */
  setValidUntil: boolean; validUntil: string | null;
  /** ISO time; null clears the expiry. */
  expiredAt: string | null;
  source: string; confidence: number;
  claimMetric: string | null; claimValue: number | null; claimUnit: string | null; claimPeriod: string | null;
}

/** Writes a fence row's cells onto fact `id`. */
export async function updateFenceFactCells(raw: EngineRawRead, sourceId: string, id: number | string, cells: FenceFactCells): Promise<void> {
  await raw(
    `UPDATE facts SET kind = $3, visibility = $4, notability = $5, context = $6,
          valid_from = CASE WHEN $7::timestamptz IS NULL OR valid_from = $7::timestamptz OR date_trunc('second', valid_from) = $7::timestamptz THEN valid_from ELSE $7::timestamptz END,
          valid_until = CASE WHEN $8::boolean THEN $9::timestamptz ELSE valid_until END,
          expired_at = CASE WHEN $10::timestamptz IS NULL THEN NULL ELSE COALESCE(expired_at, $10::timestamptz) END,
          source = $11, confidence = $12,
          claim_metric = $13, claim_value = $14, claim_unit = $15, claim_period = $16
        WHERE id = $1 AND source_id = $2`,
    [id, sourceId, cells.kind, cells.visibility, cells.notability, cells.context, cells.validFrom, cells.setValidUntil, cells.validUntil, cells.expiredAt,
      cells.source, cells.confidence, cells.claimMetric, cells.claimValue, cells.claimUnit, cells.claimPeriod],
  );
}

/**
 * The unexpired fence rows of a page coordinate whose page is soft-deleted (and, when `pageId` is given, is that page id).
 */
export async function listExpirableFactIdsOfDeletedPage(raw: EngineRawRead, sourceId: string, slug: string, pageId: number | null): Promise<Array<{ id: number }>> {
  return raw<{ id: number }>(
    `SELECT f.id FROM facts f WHERE f.source_id = $1 AND f.source_markdown_slug = $2 AND f.row_num IS NOT NULL AND f.expired_at IS NULL
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND ($3::integer IS NULL OR p.id = $3::integer) AND p.deleted_at IS NOT NULL)`,
    [sourceId, slug, pageId]);
}

/** A soft-deleted page's stored body. */
export interface DeletedPageBodyRow { compiled_truth: string | null; timeline: string | null; body_storage: BodyStorage | null }

/** The newest soft-deleted page of a coordinate's stored body, or null for none. */
export async function readDeletedPageBody(raw: EngineRawRead, sourceId: string, slug: string): Promise<DeletedPageBodyRow | null> {
  const [stored] = await raw<DeletedPageBodyRow>(
    'SELECT compiled_truth, timeline, body_storage FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NOT NULL ORDER BY id DESC LIMIT 1', [sourceId, slug]);
  return stored ?? null;
}

/** Expires the still-unexpired facts among `ids`; the ids it expired. */
export async function expireFactsByIds(raw: EngineRawRead, sourceId: string, ids: number[]): Promise<Array<{ id: number }>> {
  return raw<{ id: number }>('UPDATE facts SET expired_at = now() WHERE source_id = $1 AND id = ANY($2::bigint[]) AND expired_at IS NULL RETURNING id',
    [sourceId, ids]);
}

/** The page slugs (no `/`) that still hold an unexpired ontology observation. */
export async function listOntologyObservationSlugs(raw: EngineRawRead, sourceId: string): Promise<Array<{ slug: string }>> {
  return raw<{ slug: string }>(
    `SELECT DISTINCT source_markdown_slug AS slug FROM facts
        WHERE source_id = $1 AND dimension IS NOT NULL AND expired_at IS NULL AND source_markdown_slug NOT LIKE '%/%'`,
    [sourceId]);
}

/** The soft-deleted pages of the source that still have unexpired fence rows, in slug order. */
export async function listDeletedPageSlugsWithActiveFacts(raw: EngineRawRead, sourceId: string): Promise<Array<{ slug: string }>> {
  return raw<{ slug: string }>(
    `SELECT DISTINCT f.source_markdown_slug AS slug FROM facts f
      WHERE f.source_id = $1 AND f.row_num IS NOT NULL AND f.expired_at IS NULL
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.source_markdown_slug AND p.deleted_at IS NOT NULL)
      ORDER BY 1`,
    [sourceId],
  );
}

/** The fact columns the facts-home scan reads, as the repair adopts them. */
export interface FactHomeColumns {
  id: string;
  source_id: string;
  entity_slug: string | null;
  fact: string;
  kind: 'event' | 'preference' | 'commitment' | 'belief' | 'fact';
  visibility: 'private' | 'world';
  notability: 'high' | 'medium' | 'low';
  context: string | null;
  valid_from: Date;
  valid_until: Date | null;
  source: string;
  confidence: number;
  claim_metric: string | null;
  claim_value: number | null;
  claim_unit: string | null;
  claim_period: string | null;
  attributed_to?: FactAttribution | null;
  page_exists: boolean;
}
/** An unfenced fact the facts-home scan found, with its ontology dimension and whether its entity page is soft-deleted. */
export type UnfencedScanRow = FactHomeColumns & { dimension: string | null; page_deleted: boolean };
/** A fenced fact waiting on a holding page: when it started waiting and whether that is older than the cutoff. */
export type HeldFactRow = FactHomeColumns & { held_since: string; old: boolean; from_slug: string };

/** The source's unexpired facts with no fence row, by entity slug (null first) then id, with page-existence flags. */
export async function scanUnfencedFactRows(raw: EngineRawRead, sourceId: string): Promise<UnfencedScanRow[]> {
  return raw<UnfencedScanRow>(`SELECT f.id, f.source_id, f.entity_slug, f.fact, f.kind, f.visibility, f.notability, f.context, f.valid_from, f.valid_until, f.source,
  f.confidence, f.claim_metric, f.claim_value, f.claim_unit, f.claim_period, f.attributed_to, f.dimension, EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NULL) AS page_exists,
    EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NOT NULL) AS page_deleted FROM facts f
    WHERE f.source_id=$1 AND f.row_num IS NULL AND f.expired_at IS NULL ORDER BY f.entity_slug COLLATE "C" NULLS FIRST, f.id`, [sourceId]);
}

/**
 * The source's unexpired fence rows on a holding page (`memory/unattributed`, at any folder depth) that name another entity,
 * by entity slug then id. `days` is the age cutoff as text; the statement marks a row `old` when it is older.
 * The two holding-slug tests are `holdingSlugSql` (facts-fence.ts) written out; the pin test checks they match it.
 */
export async function listHeldFactRows(raw: EngineRawRead, sourceId: string, days: string): Promise<HeldFactRow[]> {
  return raw<HeldFactRow>(`SELECT f.id, f.source_id, f.entity_slug, f.fact, f.kind, f.visibility, f.notability, f.context, f.valid_from, f.valid_until, f.source,
  f.confidence, f.claim_metric, f.claim_value, f.claim_unit, f.claim_period, f.attributed_to, EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NULL) AS page_exists, f.source_markdown_slug AS from_slug,
      to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS held_since, f.created_at < now() - ($2 || ' days')::interval AS old
     FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug IN (SELECT hp.slug FROM pages hp WHERE hp.source_id = $1 AND (hp.slug = 'memory/unattributed' OR hp.slug LIKE '%/memory/unattributed')) AND f.row_num IS NOT NULL AND f.expired_at IS NULL AND f.dimension IS NULL
      AND f.entity_slug IS NOT NULL AND NOT (f.entity_slug = 'memory/unattributed' OR f.entity_slug LIKE '%/memory/unattributed') ORDER BY f.entity_slug COLLATE "C", f.id`, [sourceId, days]);
}

/** The source's fenced, unexpired facts whose page is missing or soft-deleted, by id, with the page slug they sit on. */
export async function listFencedFactsOfMissingPages(raw: EngineRawRead, sourceId: string): Promise<Array<{ id: number; slug: string }>> {
  return raw<{ id: number; slug: string }>(`SELECT f.id, f.source_markdown_slug AS slug FROM facts f WHERE f.source_id=$1 AND f.row_num IS NOT NULL
      AND f.expired_at IS NULL AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL) ORDER BY f.id`, [sourceId]);
}

/** The largest fence `row_num` of a page coordinate's facts, 0 for none (the fence writer's numbering hint; the caller handles a failed read). */
export async function readFenceRowNumHint(raw: EngineRawRead, sourceId: string, slug: string): Promise<number> {
  const rows = await raw<{ max_row_num: number | null }>(
    `SELECT MAX(row_num) AS max_row_num FROM facts
            WHERE source_id = $1 AND source_markdown_slug = $2`,
    [sourceId, slug],
  );
  return Number(rows[0]?.max_row_num ?? 0);
}

/** The source's checkout path, or null when the source is unknown or has none. */
export async function readSourceCheckoutPath(raw: EngineRawRead, sourceId: string): Promise<string | null> {
  const rows = await raw<{ local_path: string | null }>(
    'SELECT local_path FROM sources WHERE id = $1 LIMIT 1',
    [sourceId],
  );
  if (rows.length === 0) return null;
  return rows[0].local_path;
}

const LIVE_STORED_BODY_SQL = 'SELECT compiled_truth, timeline FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL';
const LIVE_STORED_BODY_LOCKED_SQL = 'SELECT compiled_truth, timeline FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL FOR UPDATE';

/** A page's stored body and timeline. */
export interface StoredBodyRow { compiled_truth: string | null; timeline: string | null }

/** The live page's stored body, or null for no live page. `lock` takes the row lock (inside a transaction). */
export async function readLiveStoredBody(raw: EngineRawRead, sourceId: string, slug: string, lock = false): Promise<StoredBodyRow | null> {
  const [row] = await raw<StoredBodyRow>(lock ? LIVE_STORED_BODY_LOCKED_SQL : LIVE_STORED_BODY_SQL, [sourceId, slug]);
  return row ?? null;
}

/** A stored page state a checkout file is compared with: the live row or one of its page_versions rows. */
export interface PageStateRow extends StoredBodyRow {
  frontmatter: Record<string, unknown> | null;
  title: string | null;
  type: string | null;
  tags: unknown;
}

/** The live page's state, then its 20 newest page_versions rows that hold a body, newest first. */
export async function listPageStates(raw: EngineRawRead, sourceId: string, slug: string): Promise<PageStateRow[]> {
  return raw<PageStateRow>(
    `(SELECT p.compiled_truth, p.timeline, p.frontmatter, p.title, p.type,
             to_jsonb(ARRAY(SELECT t.tag FROM tags t WHERE t.page_id = p.id)) AS tags
        FROM pages p WHERE p.source_id = $1 AND p.slug = $2)
     UNION ALL
     (SELECT v.compiled_truth, v.timeline, v.frontmatter, v.title, v.type, v.tags FROM page_versions v JOIN pages p ON p.id = v.page_id
       WHERE p.source_id = $1 AND p.slug = $2 AND v.compiled_truth IS NOT NULL ORDER BY v.id DESC LIMIT 20)`,
    [sourceId, slug]);
}

/** How many of a page's versions keep their body in segments. */
export async function countSegmentedVersionsOfPage(raw: EngineRawRead, sourceId: string, slug: string): Promise<number> {
  const [segmented] = await raw<{ n: number }>(`SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id = v.page_id
    WHERE p.source_id = $1 AND p.slug = $2 AND v.body_storage = 'segmented'`, [sourceId, slug]);
  return Number(segmented?.n ?? 0);
}
