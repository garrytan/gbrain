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
 *  - Seam: none (pure; the parameter case records what a stub raw read is sent).
 */
import { describe, expect, test } from 'bun:test';
import { PAGE_CHILD_FK_TARGETS, orphanPredicate } from '../src/core/repair/orphan-children.ts';
import { SCHEMA_PACK_SOURCE_OVERRIDE_SQL, listSchemaPackSourceOverrides, pageChildOrphanSql, type PageChildTarget } from '../src/core/engine-sql/doctor-reads.ts';
import { renderFragment } from '../src/core/engine-sql/fragment.ts';

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
});
