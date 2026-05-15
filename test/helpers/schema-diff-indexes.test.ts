/**
 * v0.34 D7 — snapshotIndexes helper unit tests.
 *
 * Pure-function tests for the index parity diff. The PG-vs-PGLite E2E
 * wiring lives in `test/e2e/schema-drift.test.ts`; this file validates
 * the diff logic in isolation against synthetic snapshots.
 */
import { describe, test, expect } from 'bun:test';
import {
  diffIndexSnapshots,
  isCleanIndexDiff,
  formatIndexDiffForFailure,
  type IndexSnapshot,
} from './schema-diff.ts';

function snap(entries: Array<{ name: string; table: string; columns: string; isUnique?: boolean; isPartial?: boolean }>): IndexSnapshot {
  const m: IndexSnapshot = new Map();
  for (const e of entries) {
    m.set(e.name, {
      indexName: e.name,
      tableName: e.table,
      columns: e.columns,
      isUnique: e.isUnique ?? false,
      isPartial: e.isPartial ?? false,
    });
  }
  return m;
}

describe('snapshotIndexes diff', () => {
  test('matching snapshots produce a clean diff', () => {
    const pg = snap([{ name: 'idx_foo', table: 'foo', columns: 'CREATE INDEX idx_foo ON foo (id)' }]);
    const pglite = snap([{ name: 'idx_foo', table: 'foo', columns: 'CREATE INDEX idx_foo ON foo (id)' }]);
    const d = diffIndexSnapshots(pg, pglite);
    expect(isCleanIndexDiff(d)).toBe(true);
  });

  test('pg-only index surfaces in pgOnly', () => {
    const pg = snap([{ name: 'idx_only_pg', table: 'foo', columns: 'CREATE INDEX idx_only_pg ON foo (id)' }]);
    const pglite = snap([]);
    const d = diffIndexSnapshots(pg, pglite);
    expect(d.pgOnly).toHaveLength(1);
    expect(d.pgOnly[0]?.indexName).toBe('idx_only_pg');
    expect(isCleanIndexDiff(d)).toBe(false);
  });

  test('pglite-only index surfaces in pgliteOnly', () => {
    const pg = snap([]);
    const pglite = snap([{ name: 'idx_pl_only', table: 'foo', columns: 'CREATE INDEX idx_pl_only ON foo (id)' }]);
    const d = diffIndexSnapshots(pg, pglite);
    expect(d.pgliteOnly).toHaveLength(1);
  });

  test('uniqueness mismatch surfaces in mismatched', () => {
    const pg = snap([{ name: 'idx_u', table: 'foo', columns: 'CREATE UNIQUE INDEX idx_u ON foo (id)', isUnique: true }]);
    const pglite = snap([{ name: 'idx_u', table: 'foo', columns: 'CREATE UNIQUE INDEX idx_u ON foo (id)', isUnique: false }]);
    const d = diffIndexSnapshots(pg, pglite);
    expect(d.mismatched).toHaveLength(1);
    expect(d.mismatched[0]?.reason).toBe('uniqueness_mismatch');
  });

  test('partial-predicate mismatch surfaces in mismatched', () => {
    const pg = snap([{ name: 'idx_p', table: 'foo', columns: 'CREATE INDEX idx_p ON foo (id) WHERE id IS NULL', isPartial: true }]);
    const pglite = snap([{ name: 'idx_p', table: 'foo', columns: 'CREATE INDEX idx_p ON foo (id) WHERE id IS NULL', isPartial: false }]);
    const d = diffIndexSnapshots(pg, pglite);
    expect(d.mismatched).toHaveLength(1);
    expect(d.mismatched[0]?.reason).toBe('partial_mismatch');
  });

  test('allowlist suppresses an index from the diff', () => {
    const pg = snap([{ name: 'idx_only_pg', table: 'foo', columns: 'CREATE INDEX idx_only_pg ON foo (id)' }]);
    const pglite = snap([]);
    const d = diffIndexSnapshots(pg, pglite, { allowlist: ['idx_only_pg'] });
    expect(isCleanIndexDiff(d)).toBe(true);
  });

  test('formatter produces a readable failure message', () => {
    const pg = snap([{ name: 'idx_missing_pl', table: 'foo', columns: 'CREATE INDEX idx_missing_pl ON foo (id)' }]);
    const pglite = snap([]);
    const d = diffIndexSnapshots(pg, pglite);
    const msg = formatIndexDiffForFailure(d);
    expect(msg).toContain('idx_missing_pl');
    expect(msg).toContain('MISSING in PGLite');
  });
});
