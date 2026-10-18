/**
 * Wave A page-size policy: the published constants and the large-page
 * threshold the ingress bounds and the large-page paths derive from.
 */
import { describe, expect, test } from 'bun:test';
import { CODE_FILE_MAX_BYTES, PAGE_INLINE_MAX_BYTES, PAGE_MAX_BYTES, isLargePageBytes } from '../src/core/page-size-policy.ts';

describe('page-size policy', () => {
  test('the ceilings are 24 MiB per page, 5 MB per code file and 1 MiB inline', () => {
    expect(PAGE_MAX_BYTES).toBe(25_165_824);
    expect(CODE_FILE_MAX_BYTES).toBe(5_000_000);
    expect(PAGE_INLINE_MAX_BYTES).toBe(1_048_576);
    expect(PAGE_INLINE_MAX_BYTES).toBeLessThan(PAGE_MAX_BYTES);
  });

  test('a page is large only above the inline threshold', () => {
    expect(isLargePageBytes(0)).toBe(false);
    expect(isLargePageBytes(PAGE_INLINE_MAX_BYTES)).toBe(false);
    expect(isLargePageBytes(PAGE_INLINE_MAX_BYTES + 1)).toBe(true);
    expect(isLargePageBytes(PAGE_MAX_BYTES)).toBe(true);
  });
});
