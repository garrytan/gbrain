/**
 * The doctor reads of src/core/engine-sql/doctor-reads.ts keep the exact statement text doctor checks built inline.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each page-child target's constant statement equals the text child_table_orphans built from
 *    `orphanPredicate` before it moved, and every PAGE_CHILD_FK_TARGETS entry except content_chunks has one.
 *  - Regression: a drifted constant (a typo, a lost SET NULL guard) changes what doctor counts on PGLite and Postgres.
 *  - Why existing coverage misses it: the parity cases compare engines, not the text against the old builder.
 *  - Contract: the schema_pack_source_drift statements are the two texts src/commands/doctor/schema-pack-checks.ts ran
 *    at 3852ea1505, with the same parameter (one `schema_pack.source.<id>` key per source id).
 *  - Contract: the contextual_retrieval_coverage, abandoned_threads and grade_confidence_drift counts are the texts
 *    src/commands/doctor/checks/calibration.ts ran at 3852ea1505 (the safe-chunk fence rendered at version 4), each scoped
 *    form adding the same source filter, with the same parameters.
 *  - Seam: none (pure; the parameter case records what a stub raw read is sent).
 */
import { describe, expect, test } from 'bun:test';
import { PAGE_CHILD_FK_TARGETS, orphanPredicate } from '../src/core/repair/orphan-children.ts';
import {
  PAGES_SAFE_CHUNKS_FILTER, SCHEMA_PACK_SOURCE_OVERRIDE_SQL, abandonedTakesCountSql, appliedTakeGradesCountSql, contextualCoverageSql,
  countAbandonedTakes, countAppliedTakeGrades, countContextualCoverage, listSchemaPackSourceOverrides, pageChildOrphanSql,
  type PageChildTarget,
} from '../src/core/engine-sql/doctor-reads.ts';
import { renderFragment } from '../src/core/engine-sql/fragment.ts';
import { safeChunksFilter } from '../src/core/search/safe-chunks.ts';

// The unscoped texts calibration.ts built inline at 3852ea1505, rendered.
const COVERAGE_AT_3852 = "SELECT\n         COUNT(*) FILTER (WHERE page_kind = 'markdown' AND chunker_version < $1)::int AS chunker_drift,\n         -- #5004/#5247: pages of every kind the safe-chunk fence withholds from\n         -- every remote read. Counted separately from drift: the chunker version\n         -- may move past the fence floor, and only the fence has this consequence.\n         COUNT(*) FILTER (WHERE NOT (pages.chunker_version >= 4))::int AS unsealed,\n         COUNT(*) FILTER (WHERE page_kind = 'code' AND NOT (pages.chunker_version >= 4))::int AS unsealed_code,\n         -- #4009 belt+braces: extract receipts are audit artifacts stamped\n         -- mode 'none' at write time, but a reindex DB fallback can clear\n         -- the stamp — never count them as \"never evaluated\".\n         COUNT(*) FILTER (WHERE page_kind = 'markdown' AND contextual_retrieval_mode IS NULL AND type <> 'extract_receipt')::int AS mode_null\n       FROM pages\n       WHERE deleted_at IS NULL\n         ";
const ABANDONED_AT_3852 = "SELECT COUNT(*)::int AS count FROM takes\n         WHERE active = true\n           AND resolved_at IS NULL\n           AND superseded_by IS NULL\n           AND weight >= 0.7\n           AND since_date IS NOT NULL\n           AND (since_date || CASE WHEN length(since_date) = 7 THEN '-01' ELSE '' END)::date\n               < (now() - INTERVAL '12 months')";
const APPLIED_AT_3852 = "SELECT COUNT(*)::int AS applied_count FROM take_grade_cache WHERE applied = true";

describe('doctor reads SQL text', () => {
  test('each page-child target has the statement orphanPredicate built', () => {
    const targets = PAGE_CHILD_FK_TARGETS.filter((t) => !(t.table === 'content_chunks' && t.col === 'page_id'));
    expect(targets.length).toBe(9);
    for (const t of targets) {
      expect(pageChildOrphanSql(`${t.table}.${t.col}` as PageChildTarget)).toBe(`SELECT COUNT(*)::int AS n FROM ${t.table} WHERE ${renderFragment(orphanPredicate(t)).text}`);
    }
  });

  test('an unknown target throws', () => {
    expect(() => pageChildOrphanSql('content_chunks.page_id' as PageChildTarget)).toThrow(/not a page child target/);
  });

  test('the schema_pack_source_drift statements are the texts schema-pack-checks.ts ran at 3852ea1505, byte for byte', async () => {
    expect(SCHEMA_PACK_SOURCE_OVERRIDE_SQL).toEqual({
      scoped: 'SELECT key, value FROM config WHERE key = ANY($1::text[])',
      unscoped: "SELECT key, value FROM config WHERE key LIKE 'schema_pack.source.%'",
    });
    const sent: Array<{ sql: string; params?: unknown[] }> = [];
    const raw = (async (sql: string, params?: unknown[]) => { sent.push({ sql, params }); return []; }) as never;
    await listSchemaPackSourceOverrides(raw, ['docs', 'gmail']);
    await listSchemaPackSourceOverrides(raw, []);
    await listSchemaPackSourceOverrides(raw, null);
    expect(sent).toEqual([
      { sql: SCHEMA_PACK_SOURCE_OVERRIDE_SQL.scoped, params: [['schema_pack.source.docs', 'schema_pack.source.gmail']] },
      { sql: SCHEMA_PACK_SOURCE_OVERRIDE_SQL.scoped, params: [[]] },
      { sql: SCHEMA_PACK_SOURCE_OVERRIDE_SQL.unscoped, params: undefined },
    ]);
  });

  test('the calibration counts are the texts calibration.ts ran at 3852ea1505, byte for byte, with the same parameters', async () => {
    expect(PAGES_SAFE_CHUNKS_FILTER).toBe(safeChunksFilter('pages'));
    expect(contextualCoverageSql(false)).toBe(COVERAGE_AT_3852);
    expect(contextualCoverageSql(true)).toBe(`${COVERAGE_AT_3852}AND source_id = ANY($2::text[])`);
    expect(abandonedTakesCountSql(false)).toBe(ABANDONED_AT_3852);
    expect(abandonedTakesCountSql(true)).toBe(`${ABANDONED_AT_3852}\n           AND page_id IN (SELECT id FROM pages WHERE source_id = ANY($1::text[]))`);
    expect(appliedTakeGradesCountSql(false)).toBe(APPLIED_AT_3852);
    expect(appliedTakeGradesCountSql(true)).toBe(
      `${APPLIED_AT_3852} AND take_id IN (SELECT t.id FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.source_id = ANY($1::text[]))`);
    const sent: Array<{ sql: string; params?: unknown[] }> = [];
    const raw = (async (sql: string, params?: unknown[]) => { sent.push({ sql, params }); return []; }) as never;
    expect(await countContextualCoverage(raw, 4, ['docs'])).toEqual({ chunker_drift: 0, unsealed: 0, unsealed_code: 0, mode_null: 0 });
    await countContextualCoverage(raw, 4, null);
    expect(await countAbandonedTakes(raw, ['docs'])).toBe(0);
    await countAbandonedTakes(raw, null);
    expect(await countAppliedTakeGrades(raw, ['docs'])).toBe(0);
    await countAppliedTakeGrades(raw, null);
    expect(sent).toEqual([
      { sql: contextualCoverageSql(true), params: [4, ['docs']] },
      { sql: COVERAGE_AT_3852, params: [4] },
      { sql: abandonedTakesCountSql(true), params: [['docs']] },
      { sql: ABANDONED_AT_3852, params: undefined },
      { sql: appliedTakeGradesCountSql(true), params: [['docs']] },
      { sql: APPLIED_AT_3852, params: undefined },
    ]);
  });
});
