/**
 * v0.38 cycle lock primitive tests.
 *
 * Covers `cycleLockIdFor(sourceId?)` exhaustively:
 *   - back-compat for undefined sourceId (legacy 'gbrain-cycle')
 *   - per-source lock IDs (`gbrain-cycle:<id>`)
 *   - internal validation via assertValidSourceId (codex r2 P1-B)
 *
 * Integration assertions (two cycles holding distinct locks, busy-lock
 * 'skipped' semantics, PGLite file+DB ordering) live in
 * test/e2e/cycle-lock-integration.test.ts so they can spin a real engine.
 */
import { describe, test, expect } from 'bun:test';
import { cycleLockIdFor } from '../src/core/cycle.ts';

describe('cycleLockIdFor', () => {
  test('returns legacy gbrain-cycle for undefined sourceId (back-compat)', () => {
    expect(cycleLockIdFor()).toBe('gbrain-cycle');
    expect(cycleLockIdFor(undefined)).toBe('gbrain-cycle');
  });

  test('returns gbrain-cycle:<source_id> for valid kebab IDs', () => {
    expect(cycleLockIdFor('default')).toBe('gbrain-cycle:default');
    expect(cycleLockIdFor('portfolio')).toBe('gbrain-cycle:portfolio');
    expect(cycleLockIdFor('a')).toBe('gbrain-cycle:a');
    expect(cycleLockIdFor('alpha-beta-gamma')).toBe('gbrain-cycle:alpha-beta-gamma');
  });

  test('produces DISTINCT lock IDs for different sources', () => {
    // The whole point — two sources must not share a lock row.
    const a = cycleLockIdFor('portfolio');
    const b = cycleLockIdFor('personal');
    expect(a).not.toBe(b);
    expect(a).not.toBe('gbrain-cycle');
    expect(b).not.toBe('gbrain-cycle');
  });

  test('legacy and per-source IDs are distinct (no collision)', () => {
    // Important for deploy-window coexistence: old-binary callers using
    // the legacy ID won't collide with new-binary callers using a
    // per-source ID. Codex r1 P0-4 residual risk is acknowledged in
    // the plan; this test guards the structural property.
    expect(cycleLockIdFor()).not.toBe(cycleLockIdFor('default'));
    expect(cycleLockIdFor()).not.toBe(cycleLockIdFor('legacy'));
  });

  describe('internal validation (codex r2 P1-B)', () => {
    test('throws on path-traversal shapes', () => {
      expect(() => cycleLockIdFor('../etc')).toThrow();
      expect(() => cycleLockIdFor('/abs')).toThrow();
      expect(() => cycleLockIdFor('a/b')).toThrow();
    });

    test('throws on whitespace', () => {
      expect(() => cycleLockIdFor('A B')).toThrow();
      expect(() => cycleLockIdFor(' a')).toThrow();
      expect(() => cycleLockIdFor('a ')).toThrow();
    });

    test('throws on underscore IDs (strict regex)', () => {
      expect(() => cycleLockIdFor('snake_id')).toThrow();
      expect(() => cycleLockIdFor('my_source')).toThrow();
    });

    test('throws on uppercase', () => {
      expect(() => cycleLockIdFor('Default')).toThrow();
      expect(() => cycleLockIdFor('PORTFOLIO')).toThrow();
    });

    test('throws on edge hyphens', () => {
      expect(() => cycleLockIdFor('-leading')).toThrow();
      expect(() => cycleLockIdFor('trailing-')).toThrow();
    });

    test('throws on 33+ char IDs', () => {
      const tooLong = 'a' + 'b'.repeat(31) + 'c'; // 33 chars
      expect(() => cycleLockIdFor(tooLong)).toThrow();
    });

    test('throws on empty string', () => {
      expect(() => cycleLockIdFor('')).toThrow();
    });

    test('error message includes the bad source_id for triage', () => {
      try {
        cycleLockIdFor('snake_id');
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as Error).message).toMatch(/snake_id/);
      }
    });
  });
});
