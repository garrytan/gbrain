/**
 * BrainEngine parity coverage list stays current.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: test/engine-parity/coverage.tsv equals the generator output,
 *    so the parity number (covered N/197) in review is real.
 *  - Regression: a new parity case, a new or renamed BrainEngine method, or
 *    a hand edit of the list that leaves the checked-in number stale.
 *  - Why existing coverage misses it: test/engine-surface-coverage.test.ts
 *    asks "is the method called anywhere in test/", not "is it compared
 *    across engine arms".
 *    Also pins that every parity file selects its arms with `testBackends()`
 *    and has a row in test/postgres-unit-arms.txt, so its Postgres arm runs
 *    in CI (the unit lanes unset DATABASE_URL and run only the PGLite arm).
 *  - Seam: none (pure file generation).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCoverage, COVERAGE_FILE, FAMILIES, parityDeclarations } from './coverage.ts';

describe('engine parity coverage list', () => {
  test('coverage.tsv is fresh (regenerate: bun test/engine-parity/coverage.ts --write)', () => {
    const report = buildCoverage();
    expect(readFileSync(COVERAGE_FILE, 'utf8')).toBe(report.text);
  });

  test('every family member is a BrainEngine method and every method has one family', () => {
    const report = buildCoverage();
    const assigned = Object.values(FAMILIES).flat();
    expect([...assigned].sort()).toEqual([...report.methods].sort());
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  test('every parity case declares at least one method, with no duplicates', () => {
    for (const decl of parityDeclarations()) {
      expect({ name: decl.name, empty: decl.methods.length === 0 }).toEqual({ name: decl.name, empty: false });
      expect({ name: decl.name, dupes: decl.methods.length - new Set(decl.methods).size }).toEqual({ name: decl.name, dupes: 0 });
    }
  });
  test('every parity file runs every arm: testBackends() and a Postgres lane row', () => {
    const dir = import.meta.dir;
    const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts') && f !== 'coverage.test.ts').sort();
    expect(files.length).toBeGreaterThan(0);
    const lanes = new Set(readFileSync(join(dir, '..', 'postgres-unit-arms.txt'), 'utf8').split('\n').map((l) => l.trim()));
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8');
      const row = `test/engine-parity/${file}`;
      expect({ file, selectsArms: text.includes('parityArms(testBackends())'), laned: lanes.has(row) })
        .toEqual({ file, selectsArms: true, laned: true });
    }
  });
});
