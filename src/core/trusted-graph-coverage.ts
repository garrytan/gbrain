/**
 * Graph coverage and surface distribution metrics.
 *
 * ## Summary
 *
 * - `trusted_graph_coverage` measures the fraction of eligible knowledge pages
 *   (live markdown pages with >= 40 characters of trimmed body content, excluding
 *   raw captures in inbox/, machine receipts, and pseudo/auto pages) that have at
 *   least one human-meant, non-mention link (inbound or outbound) to or from
 *   another live page; code chunks, images, machine stubs, and auto-linked mentions
 *   are excluded from the denominator, and the metric returns null (not 0 or 100%)
 *   when eligible_pages is 0 so unpopulated corpora are unambiguously distinguished
 *   from zero coverage.
 *
 * - `pages_by_surface` measures the breakdown of all live pages across storage
 *   surfaces (prose: live markdown knowledge pages outside inbox/; code: live
 *   page_kind='code' pages; image: live page_kind='image' pages; raw_capture: live
 *   markdown pages in inbox/; unknown: live pages with missing or unrecognized
 *   page_kind), returning zero for each surface when the brain contains no pages.
 *
 * ## Why not orphan rate
 *
 * `orphan_pages` counts every row in `pages`, so on any brain with a code
 * source it is dominated by code-chunk pages, which are wired through
 * `code_edges_symbol` and never through `links`. A real brain reads
 * "3891/3893 orphans (99.9%)" and the number carries no signal: it cannot get
 * better, and it says nothing about whether the prose graph is navigable.
 *
 * Coverage fixes the denominator (only pages that *should* be linked) and
 * tightens the numerator (only edges that mean something).
 *
 * ## Eligible pages (denominator)
 *
 * A live `page_kind = 'markdown'` page that is not:
 *   - a raw capture — `inbox/` is the triage staging area; an untriaged capture
 *     is not yet knowledge. Promotion out of `inbox/` makes it eligible.
 *   - a machine receipt — `extract_receipt` pages record extraction outcomes.
 *   - empty or boilerplate — under MIN_KNOWLEDGE_CHARS of body text.
 *   - a pseudo/auto page — reuses the slug taxonomy from orphan policy.
 *
 * `page_kind IN ('code','image')` is excluded wholesale: code pages live in the
 * symbol graph, images in neither.
 *
 * ## Trusted edges (numerator)
 *
 * A link in either direction to a live page, whose `link_source` is not
 * `'mentions'`. Auto-linked body-text mentions are graph-completeness signal,
 * not human-intent signal — `getBacklinkCounts` already excludes them from
 * search ranking for the same reason. Direction is not constrained: a hub page
 * that only links out is genuinely part of the graph.
 *
 * Deliberately NOT counted as trusted: kNN / embedding-similarity edges. None
 * are written today, and none should be until the edge model carries a type and
 * provenance — otherwise this metric would score a brain on edges nobody chose.
 *
 * ## SQL aggregation
 *
 * Counts are aggregated in the database to avoid fetching page text into JS.
 * The slug predicate is generated from the arrays in orphan-policy.ts to guarantee
 * parity between TS and SQL evaluators.
 */

import type { BrainEngine } from './engine.ts';
import {
  AUTO_SUFFIX_PATTERNS,
  DENY_PREFIXES,
  FIRST_SEGMENT_EXCLUSIONS,
  PSEUDO_SLUGS,
  RAW_SEGMENT,
} from './orphan-policy.ts';

/**
 * Shorter than a sentence — a write-probe, a stub, or a title with no body.
 * Calibrated against real brains: the gap between the longest probe page (~20
 * chars) and the shortest genuine preference page (~92 chars) is wide and
 * empty, so the threshold is not load-bearing.
 */
export const MIN_KNOWLEDGE_CHARS = 40;

/** Slug prefix of the capture triage staging area. */
const RAW_CAPTURE_PREFIX = 'inbox/';

/** Page types written by machines to record an outcome, never to hold knowledge. */
const MACHINE_STUB_TYPES = ['extract_receipt'];

import type { PagesBySurface, TrustedGraphCoverage } from './types.ts';
export type { PagesBySurface, TrustedGraphCoverage };

/**
 * SQL mirror of `shouldExcludeFromOrphanReporting`, rendered from its own constants.
 *
 * `left()`/`right()` rather than `LIKE`: the suffix `/_index` contains `_`,
 * which is a LIKE single-character wildcard, so `slug LIKE '%' || '/_index'`
 * would also match `/xindex`. Exact substring comparison has no metacharacters.
 *
 * `$1..$5` are bound by the caller in this order; `column` is the slug
 * expression to test (e.g. `p.slug`).
 */
export function pseudoOrAutoSlugSql(column: string): string {
  return `(
  ${column} = ANY($1::text[])
  OR EXISTS (SELECT 1 FROM unnest($2::text[]) AS suf WHERE right(${column}, length(suf)) = suf)
  OR position($3 IN ${column}) > 0
  OR EXISTS (SELECT 1 FROM unnest($4::text[]) AS pre WHERE left(${column}, length(pre)) = pre)
  OR split_part(${column}, '/', 1) = ANY($5::text[])
  OR position('/daily/' IN ${column}) > 0
  OR left(${column}, 7) = '_brain-'
  OR ${column} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:-.+)?$'
  OR (left(${column}, 7) = 'agents/' AND (position('/memory/dreaming/' IN ${column}) > 0 OR ${column} ~ '^agents/[^/]+/(?:agents|identity|soul|tools|user|heartbeat|dreams|dormant)$'))
)`;
}

/** Params for pseudoOrAutoSlugSql, in placeholder order ($1..$5). */
export function pseudoOrAutoSlugParams(): unknown[] {
  return [
    Array.from(PSEUDO_SLUGS),
    AUTO_SUFFIX_PATTERNS,
    RAW_SEGMENT,
    DENY_PREFIXES,
    Array.from(FIRST_SEGMENT_EXCLUSIONS),
  ];
}

/**
 * A link that is not an auto-generated body-text mention, pointing at or coming
 * from a live page. Shared by both EXISTS arms so the two directions cannot
 * drift apart.
 */
const TRUSTED_LINK_PREDICATE = `l.link_source IS DISTINCT FROM 'mentions'`;

export async function computeTrustedGraphCoverage(
  engine: BrainEngine,
  opts?: { sourceId?: string; sourceIds?: string[] },
): Promise<TrustedGraphCoverage> {
  const scope: string[] | null = opts?.sourceIds ?? (opts?.sourceId ? [opts.sourceId] : null);
  const params = [
    ...pseudoOrAutoSlugParams(),          // $1..$5
    `${RAW_CAPTURE_PREFIX}`,              // $6
    MACHINE_STUB_TYPES,                   // $7
    MIN_KNOWLEDGE_CHARS,                  // $8
    scope,                                // $9
  ];

  // The trusted-edge EXISTS runs only over rows that survived classification,
  // so an excluded page never pays for a link probe.
  const rows = await engine.executeRaw<{
    raw_capture: number;
    machine_stub: number;
    empty_or_boilerplate: number;
    pseudo_or_auto: number;
    eligible: number;
    covered: number;
  }>(
    `WITH classified AS (
       SELECT
         p.id,
         CASE
           WHEN left(p.slug, length($6)) = $6 THEN 'raw_capture'
           WHEN p.type = ANY($7::text[]) THEN 'machine_stub'
           WHEN length(btrim(p.compiled_truth)) < $8 THEN 'empty_or_boilerplate'
           WHEN ${pseudoOrAutoSlugSql('p.slug')} THEN 'pseudo_or_auto'
           ELSE 'eligible'
         END AS bucket
       FROM pages p
       WHERE p.deleted_at IS NULL
         AND p.page_kind = 'markdown'
         AND ($9::text[] IS NULL OR p.source_id = ANY($9))
     ),
     covered AS (
       SELECT count(*)::int AS n
       FROM classified c
       WHERE c.bucket = 'eligible'
         AND (
           EXISTS (
             SELECT 1 FROM links l
             JOIN pages src ON src.id = l.from_page_id
             WHERE l.to_page_id = c.id
               AND src.deleted_at IS NULL
               AND ($9::text[] IS NULL OR src.source_id = ANY($9))
               AND ${TRUSTED_LINK_PREDICATE}
           )
           OR EXISTS (
             SELECT 1 FROM links l
             JOIN pages dst ON dst.id = l.to_page_id
             WHERE l.from_page_id = c.id
               AND dst.deleted_at IS NULL
               AND ($9::text[] IS NULL OR dst.source_id = ANY($9))
               AND ${TRUSTED_LINK_PREDICATE}
           )
         )
     )
     SELECT
       count(*) FILTER (WHERE bucket = 'raw_capture')::int AS raw_capture,
       count(*) FILTER (WHERE bucket = 'machine_stub')::int AS machine_stub,
       count(*) FILTER (WHERE bucket = 'empty_or_boilerplate')::int AS empty_or_boilerplate,
       count(*) FILTER (WHERE bucket = 'pseudo_or_auto')::int AS pseudo_or_auto,
       count(*) FILTER (WHERE bucket = 'eligible')::int AS eligible,
       (SELECT n FROM covered) AS covered
     FROM classified`,
    params,
  );

  const r = rows[0];
  const eligible_pages = Number(r?.eligible ?? 0);
  const covered_pages = Number(r?.covered ?? 0);

  return {
    eligible_pages,
    covered_pages,
    coverage: eligible_pages > 0 ? covered_pages / eligible_pages : null,
    excluded: {
      raw_capture: Number(r?.raw_capture ?? 0),
      machine_stub: Number(r?.machine_stub ?? 0),
      empty_or_boilerplate: Number(r?.empty_or_boilerplate ?? 0),
      pseudo_or_auto: Number(r?.pseudo_or_auto ?? 0),
    },
  };
}

export async function computePagesBySurface(
  engine: BrainEngine,
  opts?: { sourceId?: string; sourceIds?: string[] },
): Promise<PagesBySurface> {
  const scope: string[] | null = opts?.sourceIds ?? (opts?.sourceId ? [opts.sourceId] : null);
  const rows = await engine.executeRaw<{ page_kind: string | null; raw_capture: number; total: number }>(
    `SELECT
       p.page_kind,
       count(*) FILTER (WHERE left(p.slug, length($1)) = $1)::int AS raw_capture,
       count(*)::int AS total
     FROM pages p
     WHERE p.deleted_at IS NULL
       AND ($2::text[] IS NULL OR p.source_id = ANY($2))
     GROUP BY p.page_kind`,
    [RAW_CAPTURE_PREFIX, scope],
  );

  const surface: PagesBySurface = { prose: 0, code: 0, image: 0, raw_capture: 0, unknown: 0 };
  for (const row of rows) {
    const total = Number(row.total);
    const rawCapture = Number(row.raw_capture);
    if (row.page_kind === 'markdown') {
      surface.raw_capture += rawCapture;
      surface.prose += (total - rawCapture);
    } else if (row.page_kind === 'code') {
      surface.code += total;
    } else if (row.page_kind === 'image') {
      surface.image += total;
    } else {
      surface.unknown += total;
    }
  }
  return surface;
}
