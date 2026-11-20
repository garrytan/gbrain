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
});
