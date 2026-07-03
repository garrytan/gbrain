import { describe, expect, test } from 'bun:test';
import { REQUIRED_PARITY_MATRIX } from '../src/core/testing/parity-matrix.ts';

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
});
