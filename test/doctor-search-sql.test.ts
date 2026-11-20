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
import { readProjectionBacklog } from '../src/core/engine-sql/projection-backlog.ts';
import { buildVisibilityClause } from '../src/core/search/sql-ranking.ts';
import { chunkGenerationFilter } from '../src/core/search/safe-chunks.ts';
import { pageReadFilter } from '../src/core/search/read-policy-sql.ts';
import { projectionClassSql } from '../src/core/page-state/projection-class.ts';
import type { PageReadScope } from '../src/core/types.ts';
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

  test('image hold counts keep the statement readGitImageHoldCounts ran', () => {
    expect<string>(DOCTOR_SEARCH_SQL.gitImageHoldCounts).toBe(`SELECT s.id AS source_id, COALESCE((h.completed_keys->0->>'images')::int,0) AS images
    FROM op_checkpoints h JOIN sources s ON h.fingerprint=s.id||':'||s.incarnation::text
    WHERE h.op=$1 AND s.id=ANY($2::text[]) AND COALESCE((h.completed_keys->0->>'images')::int,0)>0`);
  });

  test('the projection backlog keeps the aggregate projectionBacklog ran, for every scope shape', async () => {
    // The statement as page-state/projections.ts built it: its read filter numbers the bound values itself.
    const original = (scope: PageReadScope) => {
      const params: unknown[] = [];
      const read = pageReadFilter('p', scope, params);
      return { params, text: `SELECT COUNT(*) FILTER (WHERE k.cls='text')::int AS pending,
      COUNT(*) FILTER (WHERE k.cls='text' AND j.reason='rebuild_failed')::int AS failed,
      COUNT(*) FILTER (WHERE k.cls='sealable')::int AS sealable,
      COUNT(*) FILTER (WHERE k.cls='sealable' AND EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND c.embedding_image IS NOT NULL
        AND ${chunkGenerationFilter('p', 'c')}))::int AS sealable_with_visual,
      COUNT(*) FILTER (WHERE k.cls='reimport')::int AS reimport,
      COUNT(*) FILTER (WHERE k.cls='reimport' AND p.chunker_version < 0)::int AS ocr_required,
      COUNT(*) FILTER (WHERE k.cls='protected')::int AS protected,
      COUNT(*) FILTER (WHERE k.cls='archived')::int AS archived,
      EXTRACT(EPOCH FROM now()-MIN(j.updated_at) FILTER (WHERE k.cls IN ('text','sealable','reimport')))::float8 AS oldest,
      now()::text AS as_of
    FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation
    JOIN pages p ON p.source_id=s.id AND p.slug=j.slug AND p.deleted_at IS NULL
    CROSS JOIN LATERAL (SELECT ${projectionClassSql('p', 's')} AS cls) k
    WHERE ${read}` };
    };
    const scopes: PageReadScope[] = [{}, { sourceId: 'default' }, { sourceIds: ['a', 'b'] }, { sourceIds: [], sourceId: 'a' }, { sourceIds: ['a'], excludePrivate: true },
      { sourceId: 'a', minTrust: 'user_confirmed', suppressFlagged: true }];
    for (const scope of scopes) {
      const seen: Array<{ text: string; params: unknown[] }> = [];
      const row = { pending: '2', failed: 1, sealable: 0, sealable_with_visual: 0, reimport: 3, ocr_required: 1, protected: 0, archived: 4, oldest: 12.7, as_of: '2026-11-19 00:00:00+00' };
      const result = await readProjectionBacklog((async (text: string, params?: unknown[]) => { seen.push({ text, params: params ?? [] }); return [row]; }) as never, scope);
      expect(seen).toEqual([original(scope)]);
      expect(result).toEqual({ pending: 2, failed: 1, oldest_age_seconds: 12, sealable: 0, sealable_with_visual: 0, reimport: 3, ocr_required: 1, protected: 0, archived: 4, as_of: row.as_of });
    }
  });
});
