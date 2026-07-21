import { describe, test, expect } from 'bun:test';
import {
  factsWorldOnly,
  readableFactVisibilities,
} from '../src/core/facts/reader-trust.ts';

describe('factsWorldOnly', () => {
  test('FAIL-CLOSED: unset remote is untrusted (world-only)', () => {
    expect(factsWorldOnly({})).toBe(true);
    expect(factsWorldOnly({ remote: undefined })).toBe(true);
    expect(factsWorldOnly({ trustedFactReads: false })).toBe(true);
  });

  test('explicit remote=false (trusted local CLI) sees all', () => {
    expect(factsWorldOnly({ remote: false })).toBe(false);
    expect(factsWorldOnly({ remote: false, trustedFactReads: false })).toBe(false);
  });

  test('untrusted remote callers are world-only', () => {
    expect(factsWorldOnly({ remote: true })).toBe(true);
    expect(factsWorldOnly({ remote: true, trustedFactReads: false })).toBe(true);
  });

  test('owner-trusted remote reads bypass the world-only filter', () => {
    expect(factsWorldOnly({ remote: true, trustedFactReads: true })).toBe(false);
  });

  test('trustedFactReads is a no-op for an already-trusted local caller', () => {
    expect(factsWorldOnly({ remote: false, trustedFactReads: true })).toBe(false);
  });
});

describe('readableFactVisibilities', () => {
  test("world-only readers get the ['world'] filter (incl. unset remote)", () => {
    expect(readableFactVisibilities({ remote: true })).toEqual(['world']);
    expect(readableFactVisibilities({})).toEqual(['world']);
  });

  test('trusted readers get undefined (no filter — all rows)', () => {
    expect(readableFactVisibilities({ remote: false })).toBeUndefined();
    expect(readableFactVisibilities({ remote: true, trustedFactReads: true })).toBeUndefined();
  });
});
