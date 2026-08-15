import { describe, test, expect } from 'bun:test';
import {
  SOURCE_ID_RE,
  isValidSourceId,
  assertValidSourceId,
} from '../src/core/source-id.ts';

describe('source-id canonical validator', () => {
  describe('SOURCE_ID_RE', () => {
    test('accepts single-character ids', () => {
      expect(SOURCE_ID_RE.test('a')).toBe(true);
      expect(SOURCE_ID_RE.test('1')).toBe(true);
      expect(SOURCE_ID_RE.test('z')).toBe(true);
      expect(SOURCE_ID_RE.test('0')).toBe(true);
    });

    test('accepts kebab-case ids with interior hyphens', () => {
      expect(SOURCE_ID_RE.test('default')).toBe(true);
      expect(SOURCE_ID_RE.test('portfolio')).toBe(true);
      expect(SOURCE_ID_RE.test('my-source')).toBe(true);
      expect(SOURCE_ID_RE.test('alpha-beta-gamma')).toBe(true);
      expect(SOURCE_ID_RE.test('a-b')).toBe(true);
    });

    test('accepts max-length 32-char ids', () => {
      const max = 'a' + 'b'.repeat(30) + 'c'; // 32 chars
      expect(max.length).toBe(32);
      expect(SOURCE_ID_RE.test(max)).toBe(true);
    });

    test('rejects 33+ char ids', () => {
      const tooLong = 'a' + 'b'.repeat(31) + 'c'; // 33 chars
      expect(SOURCE_ID_RE.test(tooLong)).toBe(false);
    });

    test('rejects underscores (P1-D blast radius case)', () => {
      expect(SOURCE_ID_RE.test('snake_id')).toBe(false);
      expect(SOURCE_ID_RE.test('my_source')).toBe(false);
      expect(SOURCE_ID_RE.test('_leading')).toBe(false);
      expect(SOURCE_ID_RE.test('trailing_')).toBe(false);
    });

    test('rejects edge hyphens (boundary-bad)', () => {
      expect(SOURCE_ID_RE.test('-leading')).toBe(false);
      expect(SOURCE_ID_RE.test('trailing-')).toBe(false);
      expect(SOURCE_ID_RE.test('-')).toBe(false);
      expect(SOURCE_ID_RE.test('--')).toBe(false);
    });

    test('rejects uppercase', () => {
      expect(SOURCE_ID_RE.test('Default')).toBe(false);
      expect(SOURCE_ID_RE.test('PORTFOLIO')).toBe(false);
      expect(SOURCE_ID_RE.test('myID')).toBe(false);
    });

    test('rejects path-traversal shapes (P1-B security)', () => {
      expect(SOURCE_ID_RE.test('../etc')).toBe(false);
      expect(SOURCE_ID_RE.test('/abs')).toBe(false);
      expect(SOURCE_ID_RE.test('a/b')).toBe(false);
      expect(SOURCE_ID_RE.test('a.b')).toBe(false);
    });

    test('rejects whitespace', () => {
      expect(SOURCE_ID_RE.test('A B')).toBe(false);
      expect(SOURCE_ID_RE.test('a b')).toBe(false);
      expect(SOURCE_ID_RE.test(' a')).toBe(false);
      expect(SOURCE_ID_RE.test('a ')).toBe(false);
      expect(SOURCE_ID_RE.test('\t')).toBe(false);
      expect(SOURCE_ID_RE.test('\n')).toBe(false);
    });

    test('rejects empty string', () => {
      expect(SOURCE_ID_RE.test('')).toBe(false);
    });

    test('rejects non-ASCII', () => {
      expect(SOURCE_ID_RE.test('café')).toBe(false);
      expect(SOURCE_ID_RE.test('日本')).toBe(false);
      expect(SOURCE_ID_RE.test('𝕏')).toBe(false);
    });
  });

  describe('isValidSourceId (boolean — for silent-fallback tiers per P1-F)', () => {
    test('returns true for valid ids', () => {
      expect(isValidSourceId('default')).toBe(true);
      expect(isValidSourceId('portfolio')).toBe(true);
      expect(isValidSourceId('a')).toBe(true);
    });

    test('returns false for invalid ids without throwing', () => {
      expect(isValidSourceId('SnakeCase')).toBe(false);
      expect(isValidSourceId('snake_case')).toBe(false);
      expect(isValidSourceId('../etc')).toBe(false);
      expect(isValidSourceId('')).toBe(false);
    });

    test('returns false for non-string inputs without throwing', () => {
      expect(isValidSourceId(undefined)).toBe(false);
      expect(isValidSourceId(null)).toBe(false);
      expect(isValidSourceId(42)).toBe(false);
      expect(isValidSourceId({})).toBe(false);
      expect(isValidSourceId([])).toBe(false);
    });

    test('narrows type to string when true', () => {
      const x: unknown = 'portfolio';
      if (isValidSourceId(x)) {
        // TS narrowing check — concat would fail if x weren't string
        const _y: string = x + '-suffix';
        expect(_y).toBe('portfolio-suffix');
      } else {
        throw new Error('narrowing failed');
      }
    });
  });

  describe('assertValidSourceId (throwing — for explicit/env tiers per P1-F)', () => {
    test('returns void for valid ids', () => {
      expect(() => assertValidSourceId('default')).not.toThrow();
      expect(() => assertValidSourceId('portfolio')).not.toThrow();
      expect(() => assertValidSourceId('a')).not.toThrow();
    });

    test('throws with offending value in message for invalid ids', () => {
      expect(() => assertValidSourceId('snake_id')).toThrow(/snake_id/);
      expect(() => assertValidSourceId('../etc')).toThrow(/\.\.\/etc/);
      expect(() => assertValidSourceId('A B')).toThrow(/A B/);
    });

    test('throws on non-string inputs (JSON-stringified for debug clarity)', () => {
      expect(() => assertValidSourceId(undefined)).toThrow(/undefined|Invalid source_id/);
      expect(() => assertValidSourceId(null)).toThrow(/null/);
      expect(() => assertValidSourceId(42)).toThrow(/42/);
    });

    test('error message includes regex for caller clarity', () => {
      try {
        assertValidSourceId('snake_id');
        throw new Error('should have thrown');
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toMatch(/1-32 lowercase alnum/);
        expect(msg).toMatch(/\^\[a-z0-9\]/);
      }
    });
  });
});
