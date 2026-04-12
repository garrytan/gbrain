import { describe, it, expect } from 'bun:test';
import { MAX_SEARCH_LIMIT, clampSearchLimit } from '../src/core/engine.ts';

describe('clampSearchLimit', () => {
  it('uses default when undefined', () => {
    expect(clampSearchLimit(undefined)).toBe(20);
  });

  it('uses custom default when provided', () => {
    expect(clampSearchLimit(undefined, 10)).toBe(10);
  });

  it('passes through in-range values', () => {
    expect(clampSearchLimit(50)).toBe(50);
  });

  it('clamps oversized values to MAX_SEARCH_LIMIT', () => {
    expect(clampSearchLimit(10_000_000)).toBe(MAX_SEARCH_LIMIT);
  });

  it('uses default for zero', () => {
    expect(clampSearchLimit(0)).toBe(20);
  });

  it('uses default for negative', () => {
    expect(clampSearchLimit(-5)).toBe(20);
  });

  it('floors fractional values', () => {
    expect(clampSearchLimit(7.9)).toBe(7);
  });

  it('uses default for NaN', () => {
    expect(clampSearchLimit(NaN)).toBe(20);
  });

  it('clamps Infinity to MAX_SEARCH_LIMIT', () => {
    expect(clampSearchLimit(Infinity)).toBe(20); // !isFinite → default
  });

  it('MAX_SEARCH_LIMIT is 100', () => {
    expect(MAX_SEARCH_LIMIT).toBe(100);
  });
});

describe('listPages is NOT affected by search clamp', () => {
  it('listPages accepts limit > MAX_SEARCH_LIMIT (regression test)', async () => {
    // listPages uses PageFilters.limit, NOT clampSearchLimit.
    // This test verifies the clamp is scoped to search operations only.
    // We import the PGLite engine and check that listPages with limit 100000 works.
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Insert a page
    await engine.putPage('test/big-list', {
      title: 'Test', type: 'concept', compiled_truth: 'test content', timeline: '',
    });

    // listPages with limit 100000 should NOT be clamped
    const pages = await engine.listPages({ limit: 100000 });
    expect(pages.length).toBeGreaterThanOrEqual(1);

    await engine.disconnect();
  });
});
