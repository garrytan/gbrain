/**
 * Health: `getHealth` once for both engines (FOUNDATIONS 1, F4a).
 *
 * Three statements, no per-page rows returned to TypeScript:
 *   1. counters: page, chunk and link counts, embedding coverage, missing
 *      embeddings, dead links, entity link/timeline coverage;
 *   2. the linkable scope (live, unquarantined pages the shared orphan policy
 *      keeps, rendered in SQL by `orphanExclusionSql`) grouped by page type,
 *      with islanded and with-timeline counts per type. The brain_score
 *      timeline component's pack-aware grading (#5828) applies per type here;
 *   3. `most_connected`: in-scope link endpoints grouped per entity page.
 * Statement 2 is separate because, folded into statement 1, the combined
 * plan cost crosses Postgres's JIT thresholds on a 20k-page brain and JIT
 * compilation alone costs more than the query.
 *
 * Planner robustness: PGLite has no autovacuum, so a brain can be queried
 * before its first ANALYZE. Without statistics the planner underestimates
 * every filtered relation and picks nested loops that re-scan a subquery or
 * materialized set per outer row. The per-page and per-link checks that
 * were exposed to that (linkable flags, entity link coverage, endpoint scope
 * in `most_connected`, the chunk-to-page lookup) are written as primary-key
 * lookups the planner cannot reorder: scalar subqueries, or a LATERAL
 * subquery fenced with OFFSET 0. They stay linear with or without statistics.
 *
 * Scope (#4592): `sourceIds` > `sourceId` > brain-wide; duplicate ids count
 * once. Every count, coverage numerator and denominator, degree and the
 * islanded predicate confine to the scope; a link contributes only when both
 * endpoints are in scope, so a granted-to-ungranted edge never leaks the far
 * side through a degree or rescues a page from orphan-hood. Page-scoped
 * counts exclude soft-deleted pages (#1305); chunk and link counts stay raw,
 * matching getStats. Endpoint liveness (gbrain#4153): an inbound link counts
 * only when its source page is live, an outbound link only when its target
 * is. Quarantined pages (#4280) leave the entity denominators and the
 * linkable scope; machine leaf types leave the linkable scope through the
 * policy.
 *
 * Both engines ran these reads on the pool with no scope transaction, so the
 * statements take `LegacyUnscopedRead`.
 */
import type { BrainHealth } from '../types.ts';
import { MIN_ENTITY_PAGES_FOR_COVERAGE } from '../types.ts';
import { effectiveLinkExtractorWatermark } from '../link-extraction-watermark.ts';
import { QUARANTINE_FILTER_FRAGMENT } from '../quarantine.ts';
import { loadOrphanPolicyOverrides, orphanExclusionSql } from '../orphan-policy.ts';
import { loadTimelineGradedPredicate } from '../timeline-grading.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql } from './fragment.ts';
import { compileRowNormalizer } from './normalize.ts';

/** What getHealth needs from its engine besides the executor. */
export interface HealthDeps {
  /** Name of the registry-active embedding column (legacy column when the registry is unreadable). */
  embeddingColumn(): Promise<string>;
  countStalePagesForExtraction(opts: { sourceId?: string; versionTs: string }): Promise<number>;
  getConfig(key: string): Promise<string | null>;
}

interface LinkableTypeGroup {
  type: string;
  linkable: number;
  islanded: number;
  with_timeline: number;
}

interface HealthAggregateRow {
  page_count: number;
  embed_coverage: number;
  dead_links: number;
  missing_embeddings: number;
  link_count: number;
  entity_page_count: number;
  link_coverage: number;
  timeline_coverage: number;
}

const normalizeAggregate = compileRowNormalizer<HealthAggregateRow>({
  page_count: 'bigint',
  dead_links: 'bigint',
  missing_embeddings: 'bigint',
  link_count: 'bigint',
  entity_page_count: 'bigint',
});

export async function getHealth(
  exec: LegacyUnscopedRead,
  opts: { sourceId?: string; sourceIds?: string[] } | undefined,
  deps: HealthDeps,
): Promise<BrainHealth> {
  const requested = opts?.sourceIds ?? (opts?.sourceId ? [opts.sourceId] : null);
  const scope = requested === null ? null : [...new Set(requested)];
  const [column, orphanOverrides, isTimelineGraded] = await Promise.all([
    deps.embeddingColumn(),
    loadOrphanPolicyOverrides(deps),
    loadTimelineGradedPredicate(deps),
  ]);
  const col = trustedSql(quoteIdentifier(column));
  const inScope = {
    p: scope === null ? sqlFragment`` : sqlFragment`AND p.source_id = ANY(${scope}::text[])`,
    src: scope === null ? sqlFragment`` : sqlFragment`AND src.source_id = ANY(${scope}::text[])`,
    tgt: scope === null ? sqlFragment`` : sqlFragment`AND tgt.source_id = ANY(${scope}::text[])`,
  };
  // Endpoint checks by primary key; NULL (not true) when the row is missing.
  const liveSrc = sqlFragment`(SELECT src.deleted_at IS NULL ${inScope.src} FROM pages src WHERE src.id = l.from_page_id)`;
  const liveTgt = sqlFragment`(SELECT tgt.deleted_at IS NULL ${inScope.tgt} FROM pages tgt WHERE tgt.id = l.to_page_id)`;
  const srcInScope = sqlFragment`(SELECT TRUE ${inScope.src} FROM pages src WHERE src.id = l.from_page_id)`;
  const tgtInScope = sqlFragment`(SELECT TRUE ${inScope.tgt} FROM pages tgt WHERE tgt.id = l.to_page_id)`;
  const deadLinkScope = scope === null
    ? sqlFragment``
    : sqlFragment`AND EXISTS (SELECT 1 FROM pages src WHERE src.id = l.from_page_id ${inScope.src})`;
  const linkCountScope = scope === null
    ? sqlFragment``
    : sqlFragment`WHERE EXISTS (SELECT 1 FROM pages src WHERE src.id = l.from_page_id ${inScope.src})
                    AND EXISTS (SELECT 1 FROM pages tgt WHERE tgt.id = l.to_page_id ${inScope.tgt})`;

  const { rows: [aggregate] } = await exec.run(sqlFragment`
    WITH entity_pages AS (
      SELECT p.id FROM pages p
      WHERE p.type IN ('entity', 'person', 'company') AND p.deleted_at IS NULL
        AND ${trustedSql(QUARANTINE_FILTER_FRAGMENT)}
        ${inScope.p}
    ),
    chunk_pages AS (
      SELECT cc.page_id, count(*) AS chunks, count(*) FILTER (WHERE cc.${col} IS NOT NULL) AS embedded
        FROM content_chunks cc
       GROUP BY cc.page_id
    ),
    chunk_totals AS (
      SELECT COALESCE(sum(c.chunks) FILTER (WHERE f.eligible), 0) AS eligible,
             COALESCE(sum(c.embedded) FILTER (WHERE f.eligible), 0) AS eligible_embedded,
             COALESCE(sum(c.chunks - c.embedded) FILTER (WHERE f.eligible AND f.live), 0) AS missing
        FROM chunk_pages c
        CROSS JOIN LATERAL (
          SELECT p.deleted_at IS NULL AS live,
                 NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip') AS eligible
            FROM pages p
           WHERE p.id = c.page_id ${inScope.p}
          OFFSET 0
        ) f
    )
    SELECT
      (SELECT count(*) FROM pages p WHERE p.deleted_at IS NULL ${inScope.p}) AS page_count,
      (SELECT CASE WHEN eligible = 0 THEN 1.0 ELSE eligible_embedded::float / eligible::float END
         FROM chunk_totals)::float AS embed_coverage,
      (SELECT count(*) FROM links l
        WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = l.to_page_id)
          ${deadLinkScope}) AS dead_links,
      (SELECT missing::bigint FROM chunk_totals) AS missing_embeddings,
      (SELECT count(*) FROM links l ${linkCountScope}) AS link_count,
      (SELECT count(*) FROM entity_pages) AS entity_page_count,
      (SELECT count(*) FROM entity_pages e
        WHERE EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = e.id AND ${liveSrc}))::float /
        GREATEST((SELECT count(*) FROM entity_pages), 1)::float AS link_coverage,
      (SELECT count(*) FROM entity_pages e
        WHERE EXISTS (SELECT 1 FROM timeline_entries te WHERE te.page_id = e.id))::float /
        GREATEST((SELECT count(*) FROM entity_pages), 1)::float AS timeline_coverage
  `);
  const h = normalizeAggregate(aggregate);

  const { rows: linkableGroups } = await exec.run<LinkableTypeGroup>(sqlFragment`
    WITH linkable_pages AS MATERIALIZED (
      SELECT p.type,
             (NOT EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id AND ${liveSrc})
              AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id AND ${liveTgt})) AS islanded,
             EXISTS (SELECT 1 FROM timeline_entries te WHERE te.page_id = p.id) AS has_timeline
        FROM pages p
       WHERE p.deleted_at IS NULL
         AND ${trustedSql(QUARANTINE_FILTER_FRAGMENT)}
         ${inScope.p}
         AND NOT ${orphanExclusionSql('p', orphanOverrides)}
    )
    SELECT type, count(*)::int AS linkable,
           (count(*) FILTER (WHERE islanded))::int AS islanded,
           (count(*) FILTER (WHERE has_timeline))::int AS with_timeline
      FROM linkable_pages
     GROUP BY type
     ORDER BY type
  `);

  const farInScope = {
    to: scope === null ? sqlFragment`` : sqlFragment`AND ${tgtInScope}`,
    from: scope === null ? sqlFragment`` : sqlFragment`AND ${srcInScope}`,
  };
  const { rows: connected } = await exec.run<{ slug: string; link_count: number }>(sqlFragment`
    WITH entity_pages AS (
      SELECT p.id, p.slug FROM pages p
      WHERE p.type IN ('entity', 'person', 'company') AND p.deleted_at IS NULL
        AND ${trustedSql(QUARANTINE_FILTER_FRAGMENT)}
        ${inScope.p}
    ),
    endpoints AS (
      SELECT e.id, e.slug, 0 AS hit FROM entity_pages e
      UNION ALL
      SELECT e.id, e.slug, 1 AS hit FROM entity_pages e
        JOIN links l ON l.from_page_id = e.id ${farInScope.to}
      UNION ALL
      SELECT e.id, e.slug, 1 AS hit FROM entity_pages e
        JOIN links l ON l.to_page_id = e.id AND l.from_page_id <> l.to_page_id ${farInScope.from}
    )
    SELECT slug, sum(hit)::int AS link_count
      FROM endpoints
     GROUP BY id, slug
     ORDER BY link_count DESC, slug COLLATE "C", id
     LIMIT 5
  `);

  const watermark = await effectiveLinkExtractorWatermark(deps);
  const stalePages = scope === null
    ? await deps.countStalePagesForExtraction({ versionTs: watermark })
    : (await Promise.all(scope.map(sourceId =>
        deps.countStalePagesForExtraction({ sourceId, versionTs: watermark }),
      ))).reduce((a, b) => a + b, 0);

  let linkablePageCount = 0;
  let orphanPages = 0;
  let timelineGradedCount = 0;
  let linkableTimelinePages = 0;
  for (const group of linkableGroups) {
    linkablePageCount += Number(group.linkable);
    orphanPages += Number(group.islanded);
    if (!isTimelineGraded(group.type)) continue;
    timelineGradedCount += Number(group.linkable);
    linkableTimelinePages += Number(group.with_timeline);
  }

  const pageCount = h.page_count;
  const embedCoverage = Number(h.embed_coverage);
  const deadLinks = h.dead_links;
  const linkCount = h.link_count;
  const linkDensity = pageCount > 0 ? Math.min(linkCount / pageCount, 1) : 0;
  // A brain with no linkable (or no graded) pages gets full marks for the
  // orphan / timeline components: there is no curated graph to penalize.
  const timelineDensity = timelineGradedCount > 0 ? Math.min(linkableTimelinePages / timelineGradedCount, 1) : 1;
  const noOrphans = linkablePageCount > 0 ? 1 - (orphanPages / linkablePageCount) : 1;
  const noDeadLinks = pageCount > 0 ? 1 - Math.min(deadLinks / pageCount, 1) : 1;
  // Empty brains (pageCount === 0) score 100/100: nothing to embed, link or orphan.
  const embedCoverageScore = pageCount === 0 ? 35 : Math.round(embedCoverage * 35);
  const linkDensityScore = pageCount === 0 ? 25 : Math.round(linkDensity * 25);
  const timelineCoverageScore = pageCount === 0 ? 15 : Math.round(timelineDensity * 15);
  const noOrphansScore = pageCount === 0 ? 15 : Math.round(noOrphans * 15);
  const noDeadLinksScore = pageCount === 0 ? 10 : Math.round(noDeadLinks * 10);
  // gbrain#4147: below the small-N floor the entity ratios report null.
  const coverageGraded = h.entity_page_count >= MIN_ENTITY_PAGES_FOR_COVERAGE;

  return {
    page_count: pageCount,
    linkable_page_count: linkablePageCount,
    embed_coverage: embedCoverage,
    stale_pages: stalePages,
    orphan_pages: orphanPages,
    missing_embeddings: h.missing_embeddings,
    brain_score: embedCoverageScore + linkDensityScore + timelineCoverageScore + noOrphansScore + noDeadLinksScore,
    dead_links: deadLinks,
    entity_page_count: h.entity_page_count,
    link_coverage: coverageGraded ? Number(h.link_coverage) : null,
    timeline_coverage: coverageGraded ? Number(h.timeline_coverage) : null,
    most_connected: connected.map(c => ({ slug: c.slug, link_count: Number(c.link_count) })),
    embed_coverage_score: embedCoverageScore,
    link_density_score: linkDensityScore,
    timeline_coverage_score: timelineCoverageScore,
    no_orphans_score: noOrphansScore,
    no_dead_links_score: noDeadLinksScore,
  };
}
