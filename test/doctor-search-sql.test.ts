/**
 * The doctor search reads of src/core/engine-sql/doctor-search.ts keep the exact statement text the checks ran
 * before they moved.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each constant statement equals the text its doctor check ran (the alias statements still exported by
 *    core/repair/aliases.ts, the helpers they were built from, and the literals the other checks built inline).
 *  - Regression: a drifted constant (a lost predicate, a changed limit or order) changes what doctor counts on PGLite
 *    and Postgres, and the Rust arm would then be compared against the wrong text.
 *  - Why existing coverage misses it: the parity cases compare engines on seeded rows, not the text against the old
 *    builders.
 *  - Seam: none (pure).
 */
import { describe, expect, test } from 'bun:test';
import { DOCTOR_SEARCH_SQL } from '../src/core/engine-sql/doctor-search.ts';
import { buildVisibilityClause } from '../src/core/search/sql-ranking.ts';
import { ORPHANED_ALIAS_COUNTS_SQL, SOFT_DELETED_ALIAS_COUNT_SQL } from '../src/core/repair/aliases.ts';

describe('doctor search SQL text', () => {
  test('alias counts keep the statements the repair module exports', () => {
    expect<string>(DOCTOR_SEARCH_SQL.orphanedAliasCounts).toBe(ORPHANED_ALIAS_COUNTS_SQL);
    expect<string>(DOCTOR_SEARCH_SQL.softDeletedAliasCount).toBe(SOFT_DELETED_ALIAS_COUNT_SQL);
  });

  test('type pairs keep the skip scan the onboard check ran', () => {
    expect(DOCTOR_SEARCH_SQL.pageTypePairs).toBe(`WITH RECURSIVE pairs AS (
  (SELECT source_id, type FROM pages WHERE deleted_at IS NULL AND type IS NOT NULL ORDER BY source_id, type LIMIT 1)
  UNION ALL
  SELECT n.source_id, n.type FROM pairs, LATERAL (
    SELECT p.source_id, p.type FROM pages p
     WHERE p.deleted_at IS NULL AND p.type IS NOT NULL AND (p.source_id, p.type) > (pairs.source_id, pairs.type)
     ORDER BY p.source_id, p.type LIMIT 1) n
)
SELECT source_id, type FROM pairs`);
  });

  test('markdown body reads keep the statements the data-integrity check ran, with the listed-page limit written out', () => {
    // LISTED_PAGE_LIMIT is 100 and the check read one more row to know the list was capped.
    expect(DOCTOR_SEARCH_SQL.truncatedMarkdownBodies).toBe(`SELECT p.slug,
              length(p.compiled_truth) AS body_len,
              length(rd.data ->> 'content') AS raw_len
       FROM pages p
       JOIN raw_data rd ON rd.page_id = p.id
       WHERE rd.data ? 'content'
         AND length(rd.data ->> 'content') > 1000
         AND length(p.compiled_truth) < length(rd.data ->> 'content') * 0.3
         AND (rd.data ->> 'content') ~ '(^|\n)##+ '
       LIMIT ${100 + 1}`);
    expect(DOCTOR_SEARCH_SQL.segmentedMarkdownBodies).toBe(`SELECT COUNT(DISTINCT p.id)::int AS n
       FROM pages p
       JOIN raw_data rd ON rd.page_id = p.id
       WHERE p.body_storage = 'segmented'
         AND rd.data ? 'content'
         AND length(rd.data ->> 'content') > 1000
         AND (rd.data ->> 'content') ~ '(^|\n)##+ '`);
  });

  test('link-resolution sample reads keep the statements the calibration check ran, with its scope and the sample limit written out', () => {
    const sample = 1000;
    const scope = ' AND source_id = ANY($1::text[])';
    expect(DOCTOR_SEARCH_SQL.recentPageBodies).toBe(`SELECT compiled_truth, timeline FROM pages WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ${sample}`);
    expect(DOCTOR_SEARCH_SQL.recentPageBodiesInSources).toBe(`SELECT compiled_truth, timeline FROM pages WHERE deleted_at IS NULL${scope} ORDER BY id DESC LIMIT ${sample}`);
    expect(DOCTOR_SEARCH_SQL.segmentedRecentPages).toBe(`SELECT COUNT(*)::int AS n FROM (SELECT body_storage FROM pages WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ${sample}) s WHERE s.body_storage = 'segmented'`);
    expect(DOCTOR_SEARCH_SQL.segmentedRecentPagesInSources).toBe(`SELECT COUNT(*)::int AS n FROM (SELECT body_storage FROM pages WHERE deleted_at IS NULL${scope} ORDER BY id DESC LIMIT ${sample}) s WHERE s.body_storage = 'segmented'`);
  });

  test('hidden-by-prefix keeps the check\'s statement for one prefix, with the page-visibility clause written out', () => {
    const visibility = buildVisibilityClause('p', 's');
    const one = (scope: string) => `SELECT COUNT(DISTINCT p.id)::int AS n
       FROM pages p
       JOIN sources s ON s.id = p.source_id
       WHERE EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = p.id)
         ${visibility}
         AND p.slug LIKE $1 ESCAPE '\\'${scope}`;
    // The check counted every prefix in one statement with a FILTER per prefix; the visibility clause is
    // the same text and the prefix is now the one bound pattern.
    expect<string>(DOCTOR_SEARCH_SQL.pagesHiddenByPrefix).toBe(one(''));
    expect<string>(DOCTOR_SEARCH_SQL.pagesHiddenByPrefixInSources).toBe(one(`\n         AND p.source_id = ANY($2::text[])`));
  });
});
