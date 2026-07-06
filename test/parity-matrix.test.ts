import { describe, expect, test } from 'bun:test';
import { PARITY_COVERAGE_BACKLOG, REQUIRED_PARITY_MATRIX } from '../src/core/testing/parity-matrix.ts';
import { PgEngineBase } from '../src/core/pg-engine-base.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

function engineMethodNames(proto: object): Set<string> {
  return new Set(
    Object.getOwnPropertyNames(proto).filter((name) => {
      if (name === 'constructor' || name.startsWith('_')) return false;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      return typeof descriptor?.value === 'function';
    }),
  );
}

function sharedEngineMethodNames(): string[] {
  const sqlite = engineMethodNames(SQLiteEngine.prototype);
  const pg = engineMethodNames(PgEngineBase.prototype);
  return [...sqlite].filter((name) => pg.has(name)).sort();
}

describe('required parity matrix', () => {
  test('covers the spec-required cross-engine fixture families', () => {
    expect(REQUIRED_PARITY_MATRIX.map(entry => entry.id)).toEqual([
      'page-crud',
      'tags-links-timeline',
      'derived-jobs',
      'slug-rename',
    ]);
    for (const entry of REQUIRED_PARITY_MATRIX) {
      expect(entry.engines).toEqual(['sqlite', 'pglite']);
      expect(entry.required_operations.length).toBeGreaterThan(0);
      expect(entry.assertions.length).toBeGreaterThan(0);
    }
  });

  test('every shared engine method is parity-covered or consciously backlogged', () => {
    const covered = new Set(REQUIRED_PARITY_MATRIX.flatMap((entry) => entry.required_operations));
    const backlog = new Set(PARITY_COVERAGE_BACKLOG);
    const shared = sharedEngineMethodNames();

    const unaccounted = shared.filter((name) => !covered.has(name) && !backlog.has(name));
    expect(unaccounted).toEqual([]);

    const doubleListed = [...covered].filter((name) => backlog.has(name));
    expect(doubleListed).toEqual([]);
  });

  test('the parity coverage backlog only shrinks and never goes stale', () => {
    const shared = new Set(sharedEngineMethodNames());
    const stale = PARITY_COVERAGE_BACKLOG.filter((name) => !shared.has(name));
    expect(stale).toEqual([]);

    const sorted = [...PARITY_COVERAGE_BACKLOG].sort();
    expect([...PARITY_COVERAGE_BACKLOG]).toEqual(sorted);
    expect(new Set(PARITY_COVERAGE_BACKLOG).size).toBe(PARITY_COVERAGE_BACKLOG.length);
  });
});
