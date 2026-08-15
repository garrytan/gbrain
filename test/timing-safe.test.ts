/**
 * Tests for src/core/timing-safe.ts (v0.40 D15.5 extraction).
 *
 * Pure function: behavior tests plus a source-text grep guard that pins the
 * extraction so a future drift back to a serve-http-internal closure fails
 * loudly. Both the admin-cookie compare AND the webhook HMAC compare MUST
 * route through this helper.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { safeHexEqual } from '../src/core/timing-safe.ts';

describe('safeHexEqual behavior', () => {
  test('returns true for identical hex strings', () => {
    const hash = createHash('sha256').update('the-quick-brown-fox').digest('hex');
    expect(safeHexEqual(hash, hash)).toBe(true);
  });

  test('returns false for distinct hex strings of the same length', () => {
    const a = createHash('sha256').update('apple').digest('hex');
    const b = createHash('sha256').update('banana').digest('hex');
    expect(safeHexEqual(a, b)).toBe(false);
  });

  test('returns false on length mismatch (does NOT throw)', () => {
    expect(safeHexEqual('ab', 'abcd')).toBe(false);
    expect(safeHexEqual('', 'ab')).toBe(false);
    expect(safeHexEqual('abcd', 'ab')).toBe(false);
  });

  test('empty strings compare equal', () => {
    expect(safeHexEqual('', '')).toBe(true);
  });

  test('Buffer.from(_, "hex") is case-insensitive — same hex bytes match either case', () => {
    // Documents Node's hex-decode behavior: 'abcd' and 'ABCD' decode to the
    // same bytes, so safeHexEqual returns true. Callers normalize beforehand
    // when they need strict case-equality.
    expect(safeHexEqual('abcd', 'ABCD')).toBe(true);
  });
});

describe('extraction contract', () => {
  test('IRON-RULE: serve-http.ts imports safeHexEqual from timing-safe.ts (not redefined)', () => {
    const src = readFileSync('src/commands/serve-http.ts', 'utf8');
    // Must import from the canonical location
    expect(src).toMatch(/import\s*\{[^}]*\bsafeHexEqual\b[^}]*\}\s*from\s*['"]\.\.\/core\/timing-safe\.ts['"]/);
    // Must NOT redefine the function inside the file
    expect(src).not.toMatch(/function\s+safeHexEqual\s*\(/);
  });
});
