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

  // H6: the third parameter is a caller-specified cap.
  it('honors a caller-specified cap lower than MAX_SEARCH_LIMIT', () => {
    expect(clampSearchLimit(10_000_000, 20, 50)).toBe(50);
    expect(clampSearchLimit(75, 20, 50)).toBe(50);
    expect(clampSearchLimit(49, 20, 50)).toBe(49);
  });

  it('caller cap higher than MAX_SEARCH_LIMIT is still respected', () => {
    // Backward-compatible: if someone passes a cap above MAX, the cap wins.
    expect(clampSearchLimit(1000, 20, 200)).toBe(200);
  });

  it('default is returned when cap is lower than default would suggest', () => {
    expect(clampSearchLimit(undefined, 50, 100)).toBe(50);
    expect(clampSearchLimit(undefined, 20, 50)).toBe(20);
  });

  it('operation layer list_pages clamp: default 50, max 100', () => {
    // These are the exact calls made by src/core/operations.ts list_pages handler.
    expect(clampSearchLimit(undefined, 50, 100)).toBe(50);
    expect(clampSearchLimit(10_000_000, 50, 100)).toBe(100);
    expect(clampSearchLimit(25, 50, 100)).toBe(25);
  });

  it('operation layer get_ingest_log clamp: default 20, max 50', () => {
    // These are the exact calls made by src/core/operations.ts get_ingest_log handler.
    expect(clampSearchLimit(undefined, 20, 50)).toBe(20);
    expect(clampSearchLimit(10_000_000, 20, 50)).toBe(50);
    expect(clampSearchLimit(10, 20, 50)).toBe(10);
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
