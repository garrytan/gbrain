/**
 * CEO review D8 (2026-08 wave) — "tightest wins" precedence between an
 * explicit per-call dedupOpts.maxPerPage and the two-pass walk's widened cap.
 * The walk path itself is engine-bound and default-off, so the precedence
 * rule is a pure exported function (resolveWalkDedupCap) rather than an
 * integration fixture: a regression back to the old unconditional override
 * (silently widening a session-diversity caller's maxPerPage:1) fails here.
 */

import { describe, expect, test } from 'bun:test';
import { resolveWalkDedupCap } from '../../src/core/search/hybrid.ts';

describe('resolveWalkDedupCap (D8: tightest wins)', () => {
  test('no explicit cap → walk cap applies (legacy widening preserved)', () => {
    expect(resolveWalkDedupCap(undefined, 10)).toBe(10);
    expect(resolveWalkDedupCap(undefined, 5)).toBe(5);
  });

  test('explicit tighter cap survives the walk (the D8 fix)', () => {
    expect(resolveWalkDedupCap(1, 10)).toBe(1);
    expect(resolveWalkDedupCap(2, 5)).toBe(2);
  });

  test('explicit looser cap is clamped to the walk cap (tightest wins both ways)', () => {
    expect(resolveWalkDedupCap(20, 10)).toBe(10);
  });

  test('equal caps are stable', () => {
    expect(resolveWalkDedupCap(10, 10)).toBe(10);
  });
});
