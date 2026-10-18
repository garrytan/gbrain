/**
 * The pre-F4a `getHealth` (v0.60.34.0, both engines), kept verbatim as a test
 * oracle: three statements plus the per-page orphan policy filtered in
 * TypeScript. `test/engine-sql-health-equality.test.ts` asserts the migrated
 * single-statement implementation (`src/core/engine-sql/health.ts`) returns
 * the same value for every field on the same fixtures and scopes.
 *
 * Runs through `engine.executeRaw` so one copy serves PGLite and Postgres
 * (the two engines carried byte-equivalent SQL; only the bind syntax
 * differed). `most_connected` is returned as the engine produced it; the old
 * `ORDER BY link_count DESC` had no tie-break, so callers compare it with
 * `normalizeMostConnected` when ties straddle the top-5 cut.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import type { BrainHealth } from '../../src/core/types.ts';
import { MIN_ENTITY_PAGES_FOR_COVERAGE } from '../../src/core/types.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../../src/core/link-extraction.ts';
import { QUARANTINE_FILTER_FRAGMENT, quarantineFilterFragment } from '../../src/core/quarantine.ts';
import { shouldExcludeFromOrphanReporting, loadOrphanPolicyOverrides, gradeTimelinePages } from '../../src/core/orphan-policy.ts';
import { resolveActiveEmbeddingColumnFromEngine, quoteIdentifier } from '../../src/core/search/embedding-column.ts';

export async function legacyGetHealth(
  engine: BrainEngine,
  opts?: { sourceId?: string; sourceIds?: string[] },
): Promise<BrainHealth> {
  const scope: string[] | null = opts?.sourceIds ?? (opts?.sourceId ? [opts.sourceId] : null);
  const colId = quoteIdentifier((await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name);
  const [h] = await engine.executeRaw<Record<string, unknown>>(`
      WITH scoped_pages AS (
        SELECT id, slug, frontmatter, deleted_at, source_id FROM pages p
        WHERE ($1::text[] IS NULL OR p.source_id = ANY($1))
      ),
      entity_pages AS (
        SELECT id, slug FROM scoped_pages WHERE id IN (
          SELECT id FROM pages WHERE type IN ('entity', 'person', 'company') AND deleted_at IS NULL
            AND ${quarantineFilterFragment('pages')}
        )
      )
      SELECT
        (SELECT count(*) FROM scoped_pages WHERE deleted_at IS NULL) as page_count,
        (SELECT CASE
           WHEN count(*) FILTER (WHERE NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip')) = 0
           THEN 1.0
           ELSE count(*) FILTER (WHERE cc.${colId} IS NOT NULL
                                   AND NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip'))::float
              / count(*) FILTER (WHERE NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip'))::float
         END
         FROM content_chunks cc
         JOIN scoped_pages p ON p.id = cc.page_id) as embed_coverage,
        (SELECT count(*) FROM links l
         WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = l.to_page_id)
           AND ($1::text[] IS NULL
                OR EXISTS (SELECT 1 FROM scoped_pages sp WHERE sp.id = l.from_page_id))
        ) as dead_links,
        (SELECT count(*) FROM content_chunks cc
           JOIN scoped_pages p ON p.id = cc.page_id
          WHERE cc.${colId} IS NULL AND p.deleted_at IS NULL
            AND NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip')
        ) as missing_embeddings,
        (SELECT count(*) FROM links l
          WHERE ($1::text[] IS NULL
             OR (EXISTS (SELECT 1 FROM scoped_pages sp WHERE sp.id = l.from_page_id)
                 AND EXISTS (SELECT 1 FROM scoped_pages sp WHERE sp.id = l.to_page_id)))) as link_count,
        (SELECT count(*) FROM entity_pages) as entity_page_count,
        (SELECT count(*) FROM entity_pages e
         WHERE EXISTS (SELECT 1 FROM links l
                       JOIN scoped_pages src ON src.id = l.from_page_id
                       WHERE l.to_page_id = e.id AND src.deleted_at IS NULL))::float /
          GREATEST((SELECT count(*) FROM entity_pages), 1)::float as link_coverage,
        (SELECT count(*) FROM entity_pages e
         WHERE EXISTS (SELECT 1 FROM timeline_entries te WHERE te.page_id = e.id))::float /
          GREATEST((SELECT count(*) FROM entity_pages), 1)::float as timeline_coverage
    `, [scope]);

  const connected = await engine.executeRaw<{ slug: string; link_count: number }>(`
      SELECT p.slug,
             (SELECT count(*) FROM links l
               WHERE (l.from_page_id = p.id
                      AND ($1::text[] IS NULL
                           OR EXISTS (SELECT 1 FROM pages fp WHERE fp.id = l.to_page_id AND fp.source_id = ANY($1))))
                  OR (l.to_page_id = p.id
                      AND ($1::text[] IS NULL
                           OR EXISTS (SELECT 1 FROM pages fp WHERE fp.id = l.from_page_id AND fp.source_id = ANY($1))))
             )::int as link_count
      FROM pages p
      WHERE p.type IN ('entity', 'person', 'company') AND p.deleted_at IS NULL
        AND ${QUARANTINE_FILTER_FRAGMENT}
        AND ($1::text[] IS NULL OR p.source_id = ANY($1))
      ORDER BY link_count DESC
      LIMIT 5
    `, [scope]);

  const pageScopeRows = await engine.executeRaw<{ slug: string; type: string; islanded: boolean; has_timeline: boolean }>(`
      SELECT p.slug, p.type,
             (NOT EXISTS (SELECT 1 FROM links l
                          JOIN pages src ON src.id = l.from_page_id
                          WHERE l.to_page_id = p.id AND src.deleted_at IS NULL
                            AND ($1::text[] IS NULL OR src.source_id = ANY($1)))
              AND NOT EXISTS (SELECT 1 FROM links l
                          JOIN pages tgt ON tgt.id = l.to_page_id
                          WHERE l.from_page_id = p.id AND tgt.deleted_at IS NULL
                            AND ($1::text[] IS NULL OR tgt.source_id = ANY($1)))) as islanded,
             EXISTS (SELECT 1 FROM timeline_entries te WHERE te.page_id = p.id) as has_timeline
      FROM pages p
      WHERE p.deleted_at IS NULL
        AND ${QUARANTINE_FILTER_FRAGMENT}
        AND ($1::text[] IS NULL OR p.source_id = ANY($1))
    `, [scope]);

  const pageCount = Number(h.page_count);
  const embedCoverage = Number(h.embed_coverage);
  const stalePages = scope === null
    ? await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })
    : (await Promise.all(scope.map(sid =>
        engine.countStalePagesForExtraction({ sourceId: sid, versionTs: LINK_EXTRACTOR_VERSION_TS }),
      ))).reduce((a, b) => a + b, 0);
  const orphanOverrides = await loadOrphanPolicyOverrides(engine);
  const linkablePages = pageScopeRows.filter(row =>
    !shouldExcludeFromOrphanReporting(row.slug, orphanOverrides, { type: row.type }));
  const linkablePageCount = linkablePages.length;
  const orphanPages = linkablePages.filter(row => row.islanded).length;
  const { graded: timelineGradedCount, withTimeline: linkableTimelinePages } = await gradeTimelinePages(engine, linkablePages);
  const deadLinks = Number(h.dead_links);
  const linkCount = Number(h.link_count);

  const linkDensity = pageCount > 0 ? Math.min(linkCount / pageCount, 1) : 0;
  const timelineCoverageWhole =
    timelineGradedCount > 0 ? Math.min(linkableTimelinePages / timelineGradedCount, 1) : 1;
  const noOrphans = linkablePageCount > 0 ? 1 - (orphanPages / linkablePageCount) : 1;
  const noDeadLinks = pageCount > 0 ? 1 - Math.min(deadLinks / pageCount, 1) : 1;
  const embedCoverageScore = pageCount === 0 ? 35 : Math.round(embedCoverage * 35);
  const linkDensityScore = pageCount === 0 ? 25 : Math.round(linkDensity * 25);
  const timelineCoverageScore = pageCount === 0 ? 15 : Math.round(timelineCoverageWhole * 15);
  const noOrphansScore = pageCount === 0 ? 15 : Math.round(noOrphans * 15);
  const noDeadLinksScore = pageCount === 0 ? 10 : Math.round(noDeadLinks * 10);
  const brainScore = embedCoverageScore + linkDensityScore + timelineCoverageScore + noOrphansScore + noDeadLinksScore;

  return {
    page_count: pageCount,
    linkable_page_count: linkablePageCount,
    embed_coverage: embedCoverage,
    stale_pages: stalePages,
    orphan_pages: orphanPages,
    missing_embeddings: Number(h.missing_embeddings),
    brain_score: brainScore,
    dead_links: deadLinks,
    entity_page_count: Number(h.entity_page_count),
    // #4772: the pre-F4a implementation always graded with its hardcoded list; on
    // the gbrain-base fixtures that list and the pack agree, so the status is fixed.
    entity_types_status: 'resolved',
    link_coverage: Number(h.entity_page_count) >= MIN_ENTITY_PAGES_FOR_COVERAGE ? Number(h.link_coverage) : null,
    timeline_coverage: Number(h.entity_page_count) >= MIN_ENTITY_PAGES_FOR_COVERAGE ? Number(h.timeline_coverage) : null,
    most_connected: connected.map(c => ({ slug: c.slug, link_count: Number(c.link_count) })),
    embed_coverage_score: embedCoverageScore,
    link_density_score: linkDensityScore,
    timeline_coverage_score: timelineCoverageScore,
    no_orphans_score: noOrphansScore,
    no_dead_links_score: noDeadLinksScore,
  };
}
