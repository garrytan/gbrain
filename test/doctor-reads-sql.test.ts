/**
 * The doctor reads of src/core/engine-sql/doctor-reads.ts keep the exact statement text doctor checks built inline.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each page-child target's constant statement equals the text child_table_orphans built from
 *    `orphanPredicate` before it moved, and every PAGE_CHILD_FK_TARGETS entry except content_chunks has one.
 *  - Regression: a drifted constant (a typo, a lost SET NULL guard) changes what doctor counts on PGLite and Postgres.
 *  - Why existing coverage misses it: the parity cases compare engines, not the text against the old builder.
 *  - Seam: none (pure).
 */
import { describe, expect, test } from 'bun:test';
import { PAGE_CHILD_FK_TARGETS, orphanPredicate } from '../src/core/repair/orphan-children.ts';
import { pageChildOrphanSql, type PageChildTarget } from '../src/core/engine-sql/doctor-reads.ts';
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
});
