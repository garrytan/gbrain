import { describe, test, expect } from 'bun:test';
import { MAX_SEARCH_LIMIT, clampSearchLimit } from '../src/core/engine.ts';

// Pure unit tests for the search-limit clamp. Fast, no engine setup.
// The clamp is the shared primitive behind the M001 fix — it's called
// from both PostgresEngine and PGLiteEngine searchKeyword/searchVector
// and from hybridSearch before multiplying by 2. If any edge case
// regresses here, every caller becomes unbounded again.

describe('clampSearchLimit', () => {
  test('uses the default when limit is undefined', () => {
    expect(clampSearchLimit(undefined)).toBe(20);
  });

  test('respects a custom default when provided', () => {
    expect(clampSearchLimit(undefined, 5)).toBe(5);
  });

  test('passes through values inside the [1, MAX_SEARCH_LIMIT] range', () => {
    expect(clampSearchLimit(1)).toBe(1);
    expect(clampSearchLimit(20)).toBe(20);
    expect(clampSearchLimit(99)).toBe(99);
    expect(clampSearchLimit(MAX_SEARCH_LIMIT)).toBe(MAX_SEARCH_LIMIT);
  });

  test('clips values above MAX_SEARCH_LIMIT', () => {
    expect(clampSearchLimit(MAX_SEARCH_LIMIT + 1)).toBe(MAX_SEARCH_LIMIT);
    expect(clampSearchLimit(10_000)).toBe(MAX_SEARCH_LIMIT);
    // The attack scenario: caller ships a pathological integer. The clamp
    // is what prevents the downstream searchKeyword SQL from running with
    // LIMIT 10_000_000 once PR #44's CTE rewrite lands — and what bounds
    // the JS-side splice on master before that PR lands.
    expect(clampSearchLimit(10_000_000)).toBe(MAX_SEARCH_LIMIT);
    expect(clampSearchLimit(Number.MAX_SAFE_INTEGER)).toBe(MAX_SEARCH_LIMIT);
  });

  test('floors zero and negative values at 1 via the default path', () => {
    // A zero or negative limit is almost certainly a bug at the caller
    // rather than an attack — but we still must return *something*
    // sensible. Match the "undefined" branch: fall back to the default.
    expect(clampSearchLimit(0)).toBe(20);
    expect(clampSearchLimit(-5)).toBe(20);
    expect(clampSearchLimit(-1, 10)).toBe(10);
  });

  test('handles fractional limits by flooring', () => {
    expect(clampSearchLimit(5.9)).toBe(5);
    expect(clampSearchLimit(1.1)).toBe(1);
  });

  test('handles NaN and Infinity via the default', () => {
    // Non-finite inputs are undefined-equivalent — caller sent garbage,
    // we return the default instead of silently using it as a limit.
    expect(clampSearchLimit(Number.NaN)).toBe(20);
    expect(clampSearchLimit(Number.POSITIVE_INFINITY)).toBe(MAX_SEARCH_LIMIT);
  });

  test('MAX_SEARCH_LIMIT is a concrete positive integer', () => {
    // Pin the constant so a future "let's make this configurable"
    // refactor cannot silently raise it past the sanity ceiling.
    expect(MAX_SEARCH_LIMIT).toBeGreaterThanOrEqual(20);
    expect(MAX_SEARCH_LIMIT).toBeLessThanOrEqual(1000);
    expect(Number.isInteger(MAX_SEARCH_LIMIT)).toBe(true);
  });
});
