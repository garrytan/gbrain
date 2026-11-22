/**
 * The SQL text of the referrer reads (mentions/referrers.ts, ops/backlinks-paged.ts): the shared `typed` CTE, its
 * filters, and the full statements the engines run for the entity page's live sources, the entity card's referrer
 * groups and their page details, the referrer page and its count, the batched card counts, the record candidates and
 * their titles (engine-sql/link-temporal.ts listReferrerTargetSources, readReferrerGroupRows, readReferrerPageDetails,
 * countReferrerRows, readReferrerRows, readReferrerTargetCounts, readReferrerRecordCandidates,
 * readReferrerRecordPages). The text is master's, byte for byte: the CTEs number their parameters by hand
 * ($1..$5 fixed, then the statement's own), so they are spliced as constant text, never rebuilt with sqlFragment (which
 * would renumber a repeated parameter). Every builder here takes only code-provided aliases and the caller's read
 * scope flags; no value reaches the text. scripts/check-engine-sql-dynamic.ts vets the builders engine-sql calls.
 */
import { privatePagesFilterFastForCaller, privatePagesFilterForCaller, privateLinkOriginFilterForCaller } from '../search/private-visibility.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import { activationSuppressedSql, pageEligibleSql } from '../eligibility/sql.ts';
import { boundedBodyPrefixSql } from '../page-window/bounded-lead.ts';
import type { ReadEligibility } from '../eligibility/policy.ts';

/** The caller's read filters the referrer CTEs apply. */
export interface ReferrerSqlScope {
  excludePrivate: boolean;
  eligibility?: ReadEligibility;
  includeQuarantined?: boolean;
}

/** The caller's read filters, shared by the single-target CTE and its batched variant. */
export function referrerFilters(scope: ReferrerSqlScope) {
  return {
    targetPriv: scope.excludePrivate ? ` AND ${privatePagesFilterForCaller('t')}` : '',
    linkPriv: scope.excludePrivate ? ` AND ${privateLinkOriginFilterForCaller('l')}` : '',
    pagePriv: scope.excludePrivate ? ` AND ${privatePagesFilterFastForCaller('f')}` : '',
    pageTrust: ` AND ${pageEligibleSql('f', scope.eligibility)}${scope.includeQuarantined ? '' : ` AND ${quarantineFilterFragment('f')}`}`,
  };
}

/**
 * The shared CTE `typed`: one row per referring page with its canonical type
 * and date. Params $1..$5 are fixed (target sources, target slugs, referrer
 * sources, stored type aliases, their canonical types; all bound as text[]).
 * The target's own privacy is checked once in `tgt`, and the referring page
 * ids are collected once in `refs`, so a hub with thousands of inbound links
 * costs one hashed membership test per candidate page.
 */
export function referrersCte(scope: ReferrerSqlScope): string {
  const { targetPriv, linkPriv, pagePriv, pageTrust } = referrerFilters(scope);
  return `WITH tgt AS MATERIALIZED (
      SELECT t.id FROM pages t JOIN unnest($1::text[], $2::text[]) AS k(s, g) ON t.source_id = k.s AND t.slug = k.g
       WHERE t.deleted_at IS NULL${targetPriv}
    ),
    refs AS MATERIALIZED (
      SELECT DISTINCT l.from_page_id AS id FROM links l WHERE l.to_page_id IN (SELECT id FROM tgt)${linkPriv}
    ),
    typed AS MATERIALIZED (
      SELECT f.id, f.slug, f.source_id, f.type,
             COALESCE(f.effective_date, f.updated_at) AS d,
             COALESCE(($5::text[])[array_position($4::text[], f.type)], NULLIF(f.type, ''), 'untyped') AS canonical_type
        FROM pages f
       WHERE f.id IN (SELECT id FROM refs)
         AND f.deleted_at IS NULL AND f.source_id = ANY($3::text[])
         AND f.id NOT IN (SELECT id FROM tgt)${pagePriv}${pageTrust}
    )`;
}

/**
 * The batched variant of `referrersCte`: the same membership, filters and
 * date, with a target index `i` on every row so many entities are read in
 * one statement. Params $1..$3 are the targets (sources, slugs, indexes);
 * $4 referrer sources; $5/$6 the stored type aliases and their canonical types.
 */
export function referrersCteBatched(scope: ReferrerSqlScope): string {
  const { targetPriv, linkPriv, pagePriv, pageTrust } = referrerFilters(scope);
  return `WITH tgt AS MATERIALIZED (
      SELECT k.i, t.id FROM pages t JOIN unnest($1::text[], $2::text[], $3::int[]) AS k(s, g, i) ON t.source_id = k.s AND t.slug = k.g
       WHERE t.deleted_at IS NULL${targetPriv}
    ),
    refs AS MATERIALIZED (
      SELECT DISTINCT tg.i, l.from_page_id AS id FROM links l JOIN tgt tg ON l.to_page_id = tg.id WHERE true${linkPriv}
    ),
    typed AS MATERIALIZED (
      SELECT r.i, f.id, f.slug, f.source_id, f.type,
             COALESCE(f.effective_date, f.updated_at) AS d,
             COALESCE(($6::text[])[array_position($5::text[], f.type)], NULLIF(f.type, ''), 'untyped') AS canonical_type
        FROM refs r JOIN pages f ON f.id = r.id
       WHERE f.deleted_at IS NULL AND f.source_id = ANY($4::text[])
         AND NOT EXISTS (SELECT 1 FROM tgt x WHERE x.i = r.i AND x.id = f.id)${pagePriv}${pageTrust}
    )`;
}

/**
 * The batched card counts (engine-sql/link-temporal.ts readReferrerTargetCounts): per target index its referrer total
 * (`canonical_type` NULL) and its total for each record type. Params: the six of `referrersCteBatched`, then $7 the
 * canonical record types.
 */
export function referrerTargetCountsSql(scope: ReferrerSqlScope): string {
  return `${referrersCteBatched(scope)}
     SELECT i, NULL::text AS canonical_type, count(*)::int AS n FROM typed GROUP BY i
     UNION ALL
     SELECT i, canonical_type, count(*)::int AS n FROM typed WHERE canonical_type = ANY($7::text[]) GROUP BY i, canonical_type`;
}

/** A timestamp as UTC ISO text with microseconds (a cursor compares at full precision). */
export const dateText = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The live pages with this slug (`$1`) in these sources (`$2`, text[]): the entity page's candidate sources. */
export const REFERRER_TARGET_SOURCES_SQL = 'SELECT source_id FROM pages WHERE slug = $1 AND source_id = ANY($2::text[]) AND deleted_at IS NULL';

/** The referrer page's type filter: `$6` a canonical or stored type, or null for every type. */
const REFERRER_TYPE_FILTER = `($6::text IS NULL OR canonical_type = $6 OR type = $6)`;

/** The canonical and stored types among the referrers (no type filter). Params: the five of `referrersCte`. */
export function referrerTypesSql(scope: ReferrerSqlScope): string {
  return `${referrersCte(scope)} SELECT DISTINCT canonical_type, type FROM typed`;
}

/** The referrer page's total. Params: the five of `referrersCte`, then $6 the type (or null). */
export function referrerCountSql(scope: ReferrerSqlScope): string {
  return `${referrersCte(scope)} SELECT count(*)::int AS n FROM typed WHERE ${REFERRER_TYPE_FILTER}`;
}

/**
 * One referrer page, newest first by `(d DESC, source_id, slug)`, the text keys in byte order (COLLATE "C"). Params: the five of `referrersCte`, $6 the type (or
 * null); with a cursor $7 its date (or null), $8 its source and $9 its slug; then the row limit, last. $7 binds as text
 * (`$7::text::timestamptz`): bound as a timestamptz, postgres.js turns it into a JavaScript Date and drops the
 * microseconds, so the next page skipped a referrer dated earlier in the cursor row's millisecond.
 */
export function referrerRowsSql(scope: ReferrerSqlScope, cursor: boolean): string {
  const after = cursor ? ` AND ((d IS NOT DISTINCT FROM $7::text::timestamptz AND (source_id COLLATE "C", slug COLLATE "C") > ($8::text, $9::text))
                OR ($7::text::timestamptz IS NOT NULL AND (d < $7::text::timestamptz OR d IS NULL)))` : '';
  return `${referrersCte(scope)}
     SELECT id, slug, source_id, type, canonical_type, ${dateText('d')} AS d FROM typed
      WHERE ${REFERRER_TYPE_FILTER}${after}
      ORDER BY d DESC NULLS LAST, source_id COLLATE "C", slug COLLATE "C" LIMIT $${cursor ? 10 : 7}`;
}

/**
 * The batched record candidates: per target index the newest referrers of the record types. Params: the six of
 * `referrersCteBatched`, then $7 the canonical record types and $8 the rows kept per index.
 */
export function referrerRecordCandidatesSql(scope: ReferrerSqlScope): string {
  return `${referrersCteBatched(scope)}
     SELECT x.i, x.id, x.slug, x.source_id, x.canonical_type, ${dateText('x.d')} AS d
       FROM (SELECT DISTINCT i FROM tgt) q CROSS JOIN LATERAL (
         SELECT * FROM typed t WHERE t.i = q.i AND t.canonical_type = ANY($7::text[])
          ORDER BY t.d DESC NULLS LAST, t.source_id COLLATE "C", t.slug COLLATE "C" LIMIT $8
       ) x
      ORDER BY x.i, x.d DESC NULLS LAST, x.source_id COLLATE "C", x.slug COLLATE "C"`;
}

/** The titles and date sources of the record pages kept (`$1` the page ids, as int[]). */
export const REFERRER_RECORD_PAGES_SQL = `SELECT id, title, CASE WHEN effective_date IS NULL THEN 'updated_at' ELSE COALESCE(effective_date_source, 'effective_date') END AS date_source
         FROM pages WHERE id = ANY($1::int[])`;

/**
 * The card's groups: per-type totals by hash aggregate, then a bounded top-N per canonical type (no full sort of the
 * referrers). Params: the five of `referrersCte`, then $6 the per-group cap.
 */
export function referrerGroupsSql(scope: ReferrerSqlScope): string {
  return `${referrersCte(scope)},
     counts AS (SELECT canonical_type, count(*)::int AS n FROM typed GROUP BY canonical_type)
     SELECT x.id, x.slug, x.source_id, x.type, c.canonical_type, ${dateText('x.d')} AS d, c.n AS gtotal
       FROM counts c CROSS JOIN LATERAL (
         SELECT * FROM typed t WHERE t.canonical_type = c.canonical_type ORDER BY t.d DESC NULLS LAST, t.source_id COLLATE "C", t.slug COLLATE "C" LIMIT $6
       ) x
      ORDER BY c.canonical_type COLLATE "C", x.d DESC NULLS LAST, x.source_id COLLATE "C", x.slug COLLATE "C"`;
}

/** The card details of the referring pages a group read kept (`$1` the page ids, as int[]). */
export function referrerPageDetailsSql(): string {
  return `SELECT id, title, left(${boundedBodyPrefixSql('pages')}, 4000) AS body,
            CASE WHEN effective_date IS NULL THEN 'updated_at' ELSE COALESCE(effective_date_source, 'effective_date') END AS date_source,
            trust_tier, write_origin, ${activationSuppressedSql('pages', 'pages')} AS flagged, frontmatter
       FROM pages WHERE id = ANY($1::int[])`;
}
