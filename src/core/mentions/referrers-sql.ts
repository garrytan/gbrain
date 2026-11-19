/**
 * The SQL text of the referrer reads (mentions/referrers.ts): the shared `typed` CTE, its filters, and the full
 * statements the engines run for the entity card's referrer groups (engine-sql/link-temporal.ts
 * readReferrerGroupRows). The text is master's, byte for byte: the single-target CTE numbers its parameters by hand
 * ($1..$5 fixed, $6 the per-group cap), so it is spliced as constant text, never rebuilt with sqlFragment (which
 * would renumber a repeated parameter). Every builder here takes only code-provided aliases and the caller's read
 * scope flags; no value reaches the text. scripts/check-engine-sql-dynamic.ts vets the builders engine-sql calls.
 */
import { privatePagesFilterFastForCaller, privatePagesFilterForCaller, privateLinkOriginFilterForCaller } from '../search/private-visibility.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import { pageEligibleSql } from '../eligibility/sql.ts';
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

/** A timestamp as UTC ISO text with microseconds (a cursor compares at full precision). */
export const dateText = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The card's groups: per-type totals by hash aggregate, then a bounded top-N per canonical type (no full sort of the
 * referrers). Params: the five of `referrersCte`, then $6 the per-group cap.
 */
export function referrerGroupsSql(scope: ReferrerSqlScope): string {
  return `${referrersCte(scope)},
     counts AS (SELECT canonical_type, count(*)::int AS n FROM typed GROUP BY canonical_type)
     SELECT x.id, x.slug, x.source_id, x.type, c.canonical_type, ${dateText('x.d')} AS d, c.n AS gtotal
       FROM counts c CROSS JOIN LATERAL (
         SELECT * FROM typed t WHERE t.canonical_type = c.canonical_type ORDER BY t.d DESC NULLS LAST, t.source_id, t.slug LIMIT $6
       ) x
      ORDER BY c.canonical_type, x.d DESC NULLS LAST, x.source_id, x.slug`;
}
