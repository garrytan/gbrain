import { expect, test } from 'bun:test';
import { isNeverFiledDerivedPage } from '../src/core/persistence/git-declared.ts';
import { effectiveDbOnlyDirs } from '../src/core/storage-config.ts';

test('drift reports without a canonical file are database-only by default', () => {
  expect(isNeverFiledDerivedPage('reports/drift-2031-04-14', { source_path: null, source_uri: null })).toBe(true);
  expect(isNeverFiledDerivedPage('reports/drift-2031-04-14', { source_path: 'reports/drift-2031-04-14.md', source_uri: null })).toBe(false);
  expect(effectiveDbOnlyDirs([])).toContain('reports/');
});
