/**
 * Belief state reads: one SQL implementation for both engines (docs/designs/BELIEF_LEDGER.md sections 3-4).
 *
 * `src/core/belief/state.ts` keeps the fingerprint cache and shapes these rows into a stream's raw state; the two
 * statements it ran through executeRaw live here. A stream is one slug of one source: its page, the fence facts it
 * projects (`source_markdown_slug`), the database-only facts about it (`entity_slug` with no `source_markdown_slug`),
 * its takes, and the links and link transitions whose origin (else from) page it is.
 */
import { PAGE_INLINE_MAX_BYTES } from '../page-size-policy.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

type Row = Record<string, unknown>;

/**
 * One state read. `slugs` select the stream pages and the facts keyed to them; `pageIds` add pages by id. The `known*`
 * fields carry the batch's pre-read: `knownFp` the text hashes whose fingerprints the caller already has, `knownCounts`
 * its write counters (null: read every part), `knownPages` its stream pages as `id:slug`, `knownEntitySlugs` its facts'
 * entity slugs. `suppressed` reports every counted table as unwritten (a test switch). `planModePrev`: the caller
 * already switched to generic plans (readLedgerSource's `batch`) and this is the mode it replaced; null switches here.
 */
export interface BeliefStateRowsInput {
  sourceId: string; slugs: readonly string[]; pageIds: readonly number[]; knownFp: Record<string, string>;
  knownCounts: readonly string[] | null; knownPages: readonly string[]; knownEntitySlugs: readonly string[];
  suppressed: boolean; planModePrev: string | null;
}

/**
 * The read's rows. A part a reuse skipped (`facts`, `takes`, `links`, `transitions`) is null; `entity_pages` (slug, id
 * pairs for `knownEntitySlugs`) is set only when the facts part is skipped. `counts` is null when `track_counts` is off.
 * `writer_tier` is `current_setting('gbrain.write_trust_tier', true)`.
 */
export interface BeliefStateRows {
  pages: Row[]; counts: string[] | null; facts: Row[] | null; entity_pages: Array<[string, number]> | null;
  takes: Row[] | null; links: Row[] | null; transitions: Row[] | null; endpoints: Row[]; writer_tier: string | null;
}

const ENDS = 'from_page_id, to_page_id, origin_page_id';
/**
 * The rows a page set owns (its origin, or its from-page when it has no origin), as two index scans. Kept as a
 * subquery with OFFSET 0 so the planner drives the endpoint joins from these few rows instead of joining pages first.
 */
const OWNED_ROWS = (table: 'links' | 'link_transitions', ids: SqlFragment, ends = false) => {
  const from = trustedSql(table === 'links' ? 'links' : 'link_transitions');
  const columns = trustedSql(ends ? ENDS : '*');
  return sqlFragment`SELECT ${columns} FROM ${from} WHERE origin_page_id = ANY(${ids})
  UNION ALL SELECT ${columns} FROM ${from} WHERE origin_page_id IS NULL AND from_page_id = ANY(${ids}) OFFSET 0`;
};

/** Rows this transaction has inserted, updated or deleted in each counted table so far (the backend's pending statistics, which only grow within a transaction). */
const WRITES = [
  `pg_stat_get_xact_tuples_inserted('facts'::regclass) + pg_stat_get_xact_tuples_updated('facts'::regclass) + pg_stat_get_xact_tuples_deleted('facts'::regclass)`,
  `pg_stat_get_xact_tuples_inserted('takes'::regclass) + pg_stat_get_xact_tuples_updated('takes'::regclass) + pg_stat_get_xact_tuples_deleted('takes'::regclass)`,
  `pg_stat_get_xact_tuples_inserted('links'::regclass) + pg_stat_get_xact_tuples_updated('links'::regclass) + pg_stat_get_xact_tuples_deleted('links'::regclass)`,
  `pg_stat_get_xact_tuples_inserted('link_transitions'::regclass) + pg_stat_get_xact_tuples_updated('link_transitions'::regclass) + pg_stat_get_xact_tuples_deleted('link_transitions'::regclass)`,
] as const;
/** Each counted table's 1-based position in the counters array. */
const POSITION = ['1', '2', '3', '4'] as const;

/** SHA-256 of a claim text, the fingerprint cache's key (`textHash` in JS). */
const FACT_TEXT_HASH = `encode(sha256(convert_to(f.fact, 'UTF8')), 'hex')`;
const TAKE_TEXT_HASH = `encode(sha256(convert_to(k.claim, 'UTF8')), 'hex')`;

const FACT_COLUMNS = `f.kind, f.visibility, f.notability, f.context, f.confidence::text AS confidence,
        f.valid_from, f.valid_until, f.claim_metric, f.claim_value::text AS claim_value, f.claim_unit, f.claim_period, f.event_type,
        f.dimension, f.value, f.value_hash, f.row_num, f.trust_tier`;

/**
 * One statement: each part selects the batch's pages itself (the source, the slugs, the page ids) and returns its rows
 * as JSON. Fingerprints of the texts in `knownFp` are not recomputed (the SQL fingerprint is most of a large page's
 * read). A counted table this transaction has not written since the pre-read (`knownCounts` its counters, `knownPages`
 * its pages, `suppressed` the test switch) is not read again while the stream pages are the same pages at the same
 * slugs; `knownEntitySlugs` names the entity slugs whose pages are then read fresh. The statement runs with a generic
 * plan, restored after to the previous mode: under the default plan_cache_mode a bulk import re-plans it for every page
 * as the tables grow (about 3 ms each, rising with size).
 */
export async function readBeliefStateRows(exec: LegacyUnscopedRead, input: BeliefStateRowsInput): Promise<BeliefStateRows> {
  const planModePrev = input.planModePrev ?? (await exec.executeRaw<{ prev: string }>(`SELECT current_setting('plan_cache_mode') AS prev,
    set_config('plan_cache_mode', 'force_generic_plan', true)`))[0]!.prev;
  const src = input.sourceId, slugs = [...input.slugs], ids = [...input.pageIds];
  const counts = input.knownCounts ? [...input.knownCounts] : null, suppressed = input.suppressed;
  const inBatch = sqlFragment`p.source_id = ${src} AND (p.slug = ANY(${slugs}::text[]) OR p.id = ANY(${ids}::int[]))`;
  const streamSlugs = sqlFragment`${slugs}::text[] || ARRAY(SELECT p.slug FROM pages p WHERE p.source_id = ${src} AND p.id = ANY(${ids}::int[]))`;
  const pageIds = sqlFragment`ARRAY(SELECT p.id FROM pages p WHERE ${inBatch})`;
  const unwritten = (i: 0 | 1 | 2 | 3) =>
    sqlFragment`(SELECT ok FROM reuse) AND (${suppressed}::boolean OR (${trustedSql(WRITES[i])})::text = (${counts}::text[])[${trustedSql(POSITION[i])}])`;
  const part = (i: 0 | 1 | 2 | 3, rows: SqlFragment) => sqlFragment`CASE WHEN ${unwritten(i)} THEN NULL ELSE (SELECT COALESCE(json_agg(q), '[]'::json) FROM (
${rows}) q) END`;
  const { rows: [row] } = await exec.run<Row>(sqlFragment`WITH reuse AS (SELECT (${suppressed}::boolean OR current_setting('track_counts') = 'on')
      AND ${counts}::text[] IS NOT NULL AND ARRAY(SELECT p.id || ':' || p.slug FROM pages p
        WHERE ${inBatch} ORDER BY 1) = ARRAY(SELECT unnest(${[...input.knownPages]}::text[]) ORDER BY 1) AS ok),
    known_fp AS (SELECT ${JSON.stringify(input.knownFp)}::text::jsonb AS m)
  SELECT set_config('plan_cache_mode', ${planModePrev}, true) AS restored, current_setting('gbrain.write_trust_tier', true) AS writer_tier,
    (SELECT COALESCE(json_agg(q), '[]'::json) FROM (
SELECT p.id, p.slug, p.deleted_at IS NOT NULL AS deleted, p.knowledge_revision::text AS revision,
      p.content_hash, p.trust_tier, (${trustedSql(privatePagesFilterFragment('p'))}) AS visible, s.incarnation::text AS incarnation,
      (p.body_storage = 'segmented' OR octet_length(COALESCE(p.compiled_truth,'')) + octet_length(COALESCE(p.timeline,'')) > ${PAGE_INLINE_MAX_BYTES}::int) AS large
    FROM pages p JOIN sources s ON s.id = p.source_id
    WHERE ${inBatch}) q) AS pages,
    CASE WHEN current_setting('track_counts') = 'on' THEN json_build_array((${trustedSql(WRITES[0])})::text, (${trustedSql(WRITES[1])})::text,
      (${trustedSql(WRITES[2])})::text, (${trustedSql(WRITES[3])})::text) END AS counts,
    ${part(0, sqlFragment`SELECT f.id, f.entity_slug, f.source_markdown_slug AS sms, pe.id AS entity_page_id, f.fact, h.th,
        COALESCE((SELECT m FROM known_fp) ->> h.th, gbrain_fact_fingerprint(f.fact)) AS fp, ${trustedSql(FACT_COLUMNS)}
      FROM (SELECT * FROM facts WHERE source_id = ${src} AND expired_at IS NULL AND source_markdown_slug = ANY(${streamSlugs})
        UNION ALL SELECT * FROM facts WHERE source_id = ${src} AND expired_at IS NULL AND source_markdown_slug IS NULL AND entity_slug = ANY(${streamSlugs})) f
        CROSS JOIN LATERAL (SELECT ${trustedSql(FACT_TEXT_HASH)} AS th) h
        LEFT JOIN pages pe ON pe.source_id = f.source_id AND pe.slug = f.entity_slug`)} AS facts,
    CASE WHEN ${unwritten(0)} THEN (SELECT COALESCE(json_agg(json_build_array(p.slug, p.id)), '[]'::json) FROM pages p
      WHERE p.source_id = ${src} AND p.slug = ANY(${[...input.knownEntitySlugs]}::text[])) END AS entity_pages,
    ${part(1, sqlFragment`SELECT k.id, k.page_id, k.row_num, k.claim, h.th, COALESCE((SELECT m FROM known_fp) ->> h.th, gbrain_fact_fingerprint(k.claim)) AS claim_fp,
        k.kind, k.holder, k.weight::text AS weight, k.since_date, k.until_date, k.source, k.active, k.resolved_at, k.resolved_outcome,
        k.resolved_value::text AS resolved_value, k.resolved_unit, k.resolved_source, k.resolved_by, k.resolved_quality, k.trust_tier
      FROM takes k CROSS JOIN LATERAL (SELECT ${trustedSql(TAKE_TEXT_HASH)} AS th) h WHERE k.page_id = ANY(${pageIds})`)} AS takes,
    ${part(2, sqlFragment`SELECT l.id, l.from_page_id AS f, l.to_page_id AS t, l.origin_page_id AS o,
        l.link_type, l.link_source, l.context, l.origin_field, l.link_kind, l.resolution_type, l.assertion_tense
      FROM (${OWNED_ROWS('links', pageIds)}) l`)} AS links,
    ${part(3, sqlFragment`SELECT x.id, x.from_page_id AS f, x.to_page_id AS t, x.origin_page_id AS o,
        x.link_type, x.kind, x.occurred_on::text AS occurred_on, x.date_precision, x.producer, x.line_hash
      FROM (${OWNED_ROWS('link_transitions', pageIds)}) x`)} AS transitions,
    (SELECT COALESCE(json_agg(q), '[]'::json) FROM (
SELECT p.id, p.slug, p.source_id, s.incarnation::text AS incarnation FROM pages p JOIN sources s ON s.id = p.source_id
      WHERE p.id = ANY(ARRAY(SELECT unnest(ARRAY[e.from_page_id, e.to_page_id, e.origin_page_id])
        FROM ((${OWNED_ROWS('links', pageIds, true)}) UNION ALL (${OWNED_ROWS('link_transitions', pageIds, true)})) e))) q) AS endpoints`);
  return {
    pages: row!.pages as Row[], counts: (row!.counts as string[] | null) ?? null, facts: (row!.facts as Row[] | null) ?? null,
    entity_pages: (row!.entity_pages as Array<[string, number]> | null) ?? null, takes: (row!.takes as Row[] | null) ?? null,
    links: (row!.links as Row[] | null) ?? null, transitions: (row!.transitions as Row[] | null) ?? null, endpoints: row!.endpoints as Row[],
    writer_tier: (row!.writer_tier as string | null) ?? null,
  };
}
