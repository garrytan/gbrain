/**
 * The purge probe's identifier builders (src/core/engine-sql/purge-verify.ts): purgeProbeTableSql and
 * purgeProbeColumnSql. Both are VETTED_BUILDERS entries in scripts/check-engine-sql-dynamic.ts, so the guard trusts
 * whatever they return as SQL text; this file is what makes that trust earned.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each builder returns a name only when the deletion inventory lists it (the table, or the column for
 *    that table, or a probe column of that table) and it is a plain lower-case identifier; every other name throws
 *    before any SQL is built.
 *  - Regression: a builder that returned its input unchecked would let a caller's table or column text reach a
 *    statement the guard reports as clean (SQL injection, or a probe of a catalog table outside the inventory).
 *  - Why existing coverage misses it: the guard only checks that the call is to a vetted name, never what the builder
 *    does; the parity test reaches the refusal through countPurgeProbe on two names only.
 *  - Seam: none. Pure functions over the real DELETION_INVENTORY_BY_TABLE.
 */
import { describe, expect, test } from 'bun:test';
import { DELETION_INVENTORY_BY_TABLE } from '../src/core/deletion-inventory.ts';
import { purgeProbeColumnSql, purgeProbeTableSql } from '../src/core/engine-sql/purge-verify.ts';

describe('purge probe identifier builders', () => {
  test('every inventory table, and each of its columns and probe columns, comes back unchanged', () => {
    expect(DELETION_INVENTORY_BY_TABLE.size).toBeGreaterThan(0);
    for (const [table, entry] of DELETION_INVENTORY_BY_TABLE) {
      expect(purgeProbeTableSql(table)).toBe(table);
      for (const column of [...entry.columns, ...(entry.probe ?? [])]) expect(purgeProbeColumnSql(table, column)).toBe(column);
    }
  });

  test.each([
    'pg_class', 'pg_catalog.pg_class', 'information_schema.tables', 'secret_plan_table', 'Pages', 'pages ', 'pages;DROP TABLE pages',
    'pages p', '"pages"', 'pages--', '', 'public.pages',
  ])('a table the inventory does not list is refused: %p', (table) => {
    expect(() => purgeProbeTableSql(table)).toThrow(/is not an inventory table/);
    expect(() => purgeProbeColumnSql(table, 'slug')).toThrow(/is not an inventory table/);
  });

  test.each([
    ['pages', 'id; DROP TABLE pages'], ['pages', 'slug OR true'], ['pages', 'Slug'], ['pages', 'no_such_column'],
    ['pages', ''], ['pages', 'pg_read_file'], ['links', 'compiled_truth'], ['links', '"context"'],
  ])('a column the inventory does not list for %p is refused: %p', (table, column) => {
    expect(() => purgeProbeColumnSql(table, column)).toThrow(/is not an inventory column/);
  });
});
