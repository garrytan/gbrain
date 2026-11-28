/**
 * The doctor page reads of src/core/engine-sql/doctor-pages.ts keep the exact statement text the checks built inline
 * before they moved.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each constant statement equals the text its doctor check built (with the builders it used where one
 *    still exists: the embed-skip filter, the unverified-extraction fragment, the transcript predicate, the bounded
 *    body prefix), and the row limits equal the limits those checks read with.
 *  - Regression: a drifted constant (a lost predicate, a changed limit or order) changes what doctor counts on PGLite
 *    and Postgres, and the Rust arm would then be compared against the wrong text.
 *  - Why existing coverage misses it: the parity cases compare engines on seeded rows, not the text against the old
 *    builders.
 *  - Seam: none (pure).
 */
import { describe, expect, test } from 'bun:test';
import { DOCTOR_PAGES_SQL, OVERSIZED_PAGE_ROWS, SLUG_PATH_CANDIDATE_PATTERN, SLUG_PATH_CANDIDATE_ROWS } from '../src/core/engine-sql/doctor-pages.ts';
import { EMBED_SKIP_FILTER_FRAGMENT } from '../src/core/embed-skip.ts';
import { unverifiedExtractionFragment } from '../src/core/extraction-review.ts';
import { TRANSCRIPT_PAGE_PREDICATE } from '../src/core/transcripts/secret-audit.ts';
import { boundedBodyPrefixSql } from '../src/core/page-window/bounded-lead.ts';
import { SLUG_PATH_SCAN_LIMIT } from '../src/commands/doctor/checks/slug-path-mismatch.ts';

const RAW_PROVENANCE_WHERE = `
        p.deleted_at IS NULL
    AND (COALESCE(p.frontmatter->>'dream_generated', '') = 'true' OR p.type = 'synthesis')
    AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ?| ARRAY['raw_trace', 'raw_source', 'source_uri'])
    AND COALESCE(p.frontmatter->>'raw_trace_exempt', '') <> 'true'
    AND NOT (p.type = 'atom'
      AND COALESCE(p.frontmatter->>'extracted_by', '') LIKE 'extract\\_atoms%'
      AND COALESCE(p.frontmatter, '{}'::jsonb) ?| ARRAY['source_slug', 'source_path'])
    AND NOT EXISTS (SELECT 1 FROM raw_data rd WHERE rd.page_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM synthesis_evidence se WHERE se.synthesis_page_id = p.id)`;

const unverified = (srcClause: string) => `SELECT COUNT(*)::int AS n FROM pages p
       WHERE p.deleted_at IS NULL
         AND ${unverifiedExtractionFragment('p')}
         AND p.created_at < now() - ($1 || ' days')::interval
         ${srcClause}`;

describe('doctor pages SQL text', () => {
  test('oversized pages: the embed-skip filter, ordered by size, one row over the list limit', () => {
    expect(DOCTOR_PAGES_SQL.oversizedPages).toBe(`SELECT p.slug, p.source_id,
              octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) AS bytes
       FROM pages p
       WHERE p.deleted_at IS NULL
         AND ${EMBED_SKIP_FILTER_FRAGMENT}
         AND (octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, ''))) > $1
       ORDER BY bytes DESC
       LIMIT ${100 + 1}`);
    expect(OVERSIZED_PAGE_ROWS).toBe(101);
  });

  test('raw provenance: the count and the five-slug sample share the check predicate', () => {
    expect(DOCTOR_PAGES_SQL.rawProvenanceCount).toBe(`SELECT COUNT(*)::int AS n FROM pages p WHERE ${RAW_PROVENANCE_WHERE}`);
    expect(DOCTOR_PAGES_SQL.rawProvenanceSample).toBe(`SELECT p.slug FROM pages p WHERE ${RAW_PROVENANCE_WHERE} ORDER BY p.slug COLLATE "C" LIMIT 5`);
  });

  test('unverified extractions: the fragment and the day cutoff, with and without a source', () => {
    expect<string>(DOCTOR_PAGES_SQL.unverifiedExtractions).toBe(unverified(''));
    expect<string>(DOCTOR_PAGES_SQL.unverifiedExtractionsInSource).toBe(unverified('AND p.source_id = $2'));
  });

  test('transcript pages and facts bodies use the shared predicate and prefix builders', () => {
    expect(DOCTOR_PAGES_SQL.transcriptImportPages).toBe(`SELECT count(*) AS n FROM pages WHERE ${TRANSCRIPT_PAGE_PREDICATE}`);
    expect<string>(DOCTOR_PAGES_SQL.factsPageBodies).toBe(`SELECT p.slug, p.source_id, p.body_storage = 'segmented' AS segmented, ${boundedBodyPrefixSql('p')} AS body
         FROM pages p WHERE p.type = 'facts' AND p.deleted_at IS NULL ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C"`);
  });

  test('slug-path candidates: the scan limit plus one, with and without a source scope', () => {
    expect(SLUG_PATH_CANDIDATE_ROWS).toBe(SLUG_PATH_SCAN_LIMIT + 1);
    const base = `SELECT p.source_id, p.slug, p.source_path FROM pages p JOIN sources s ON s.id = p.source_id AND s.archived IS NOT TRUE
        WHERE p.deleted_at IS NULL AND NULLIF(btrim(p.source_path), '') IS NOT NULL AND p.slug ~ $1`;
    const tail = `
        ORDER BY p.id LIMIT ${SLUG_PATH_SCAN_LIMIT + 1}`;
    expect(DOCTOR_PAGES_SQL.slugPathCandidates).toBe(`${base}${tail}`);
    expect(DOCTOR_PAGES_SQL.slugPathCandidatesInSources).toBe(`${base} AND p.source_id = ANY($2::text[])${tail}`);
    expect(SLUG_PATH_CANDIDATE_PATTERN).toBe('[^a-z0-9/._-]|--|-/|/-|^-|-$|//');
  });

  test('the multi_source_drift probe sends the text src/core/multi-source-drift.ts ran at 3852ea1505, byte for byte', () => {
    expect(DOCTOR_PAGES_SQL.slugSourceProbe).toBe(`
    WITH candidates(slug) AS (SELECT unnest($1::text[]))
    SELECT c.slug, p.source_id
    FROM candidates c
    LEFT JOIN pages p
      ON p.slug = c.slug AND p.deleted_at IS NULL
         AND p.source_id IN ('default', $2::text)
    ORDER BY c.slug, p.source_id
  `);
  });

  // The scraper scan also says which rows are segmented, so content_sanity counts them from the scan (no second query).
  test('the other reads keep the text the checks ran', () => {
    expect(DOCTOR_PAGES_SQL.scraperJunkLimited).toBe(`SELECT p.slug, p.source_id, p.title,
                  LEFT(p.compiled_truth, 2048) AS body_head,
                  LEFT(COALESCE(p.timeline, ''), 1024) AS tl_head,
                  p.frontmatter, p.body_storage = 'segmented' AS segmented
             FROM pages p
            WHERE p.deleted_at IS NULL
            ORDER BY p.updated_at DESC
            LIMIT $1`);
    expect(DOCTOR_PAGES_SQL.scraperJunkAll).toBe(`SELECT p.slug, p.source_id, p.title,
                  LEFT(p.compiled_truth, 2048) AS body_head,
                  LEFT(COALESCE(p.timeline, ''), 1024) AS tl_head,
                  p.frontmatter, p.body_storage = 'segmented' AS segmented
             FROM pages p
            WHERE p.deleted_at IS NULL`);
    expect(DOCTOR_PAGES_SQL.markedPages.quarantine).toBe(`SELECT COUNT(*)::int AS n FROM pages p WHERE p.deleted_at IS NULL AND p.frontmatter ? 'quarantine'`);
    expect(DOCTOR_PAGES_SQL.markedPages.content_flag).toBe(`SELECT COUNT(*)::int AS n FROM pages p WHERE p.deleted_at IS NULL AND p.frontmatter ? 'content_flag'`);
    expect(DOCTOR_PAGES_SQL.oversizedCorePages).toBe(`SELECT COUNT(*)::int AS n FROM pages p
    WHERE p.deleted_at IS NULL AND p.frontmatter @> '{"always_load": true}'::jsonb AND p.body_storage = 'segmented' AND p.body_bytes > $1`);
    expect(DOCTOR_PAGES_SQL.contentHashDuplicates).toBe(`SELECT source_id, content_hash,
              string_agg(slug, '|' ORDER BY length(slug), slug COLLATE "C") AS slugs
         FROM pages
        WHERE deleted_at IS NULL AND content_hash IS NOT NULL AND content_hash <> ''
        GROUP BY source_id, content_hash
       HAVING count(*) > 1
        LIMIT 51`);
    expect(DOCTOR_PAGES_SQL.pageRows).toBe('SELECT COUNT(*)::int AS n FROM pages');
    expect(DOCTOR_PAGES_SQL.pagesBySlugPrefix).toBe(`SELECT COUNT(*)::int AS n FROM pages WHERE slug LIKE $1 ESCAPE '\\'`);
    expect(DOCTOR_PAGES_SQL.livePages).toBe('SELECT COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL');
    expect(DOCTOR_PAGES_SQL.oldestPage).toBe('SELECT MIN(created_at) AS oldest FROM pages');
    expect(DOCTOR_PAGES_SQL.pageTrustTiers).toBe('SELECT trust_tier AS tier, count(*) AS n FROM pages GROUP BY trust_tier');
    expect(DOCTOR_PAGES_SQL.pagesWithMentions).toBe(`SELECT COUNT(DISTINCT l.from_page_id)::int AS count
       FROM links l
       JOIN pages p ON p.id = l.from_page_id
      WHERE l.link_source = 'mentions'
        AND p.deleted_at IS NULL`);
    expect(DOCTOR_PAGES_SQL.imageModalityMismatch).toBe(`SELECT COUNT(*)::text AS count FROM content_chunks
       WHERE embedding_image IS NOT NULL
         AND chunk_source = 'image_asset'
         AND (modality IS NULL OR modality != 'image')`);
    expect(DOCTOR_PAGES_SQL.imagePageCoverage).toBe(`SELECT count(*)::int AS image_pages,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id = p.id AND c.embedding_image IS NOT NULL))::int AS without_image_vector,
         count(*) FILTER (WHERE p.source_path IS NULL)::int AS null_source_path
       FROM pages p WHERE p.page_kind = 'image' AND p.deleted_at IS NULL`);
    expect(DOCTOR_PAGES_SQL.bracketPathPages).toBe(`SELECT slug, source_id, source_path FROM pages
          WHERE source_path IS NOT NULL AND deleted_at IS NULL
            AND (source_path LIKE '%[%' OR source_path LIKE '%]%'
                 OR source_path ~ '[[:cntrl:]]')`);
  });
});
