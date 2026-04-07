import { describe, test, expect } from 'bun:test';
import { validateSlug, contentHash } from '../src/core/utils.ts';

describe('validateSlug', () => {
  test('accepts valid slugs', () => {
    expect(() => validateSlug('people/john-doe')).not.toThrow();
    expect(() => validateSlug('companies/acme')).not.toThrow();
    expect(() => validateSlug('a')).not.toThrow();
    expect(() => validateSlug('a/b/c')).not.toThrow();
    expect(() => validateSlug('test_slug-123')).not.toThrow();
  });

  test('rejects empty slug', () => {
    expect(() => validateSlug('')).toThrow('Invalid slug');
  });

  test('rejects path traversal', () => {
    expect(() => validateSlug('../etc/passwd')).toThrow('Invalid slug');
    expect(() => validateSlug('people/../secrets')).toThrow('Invalid slug');
  });

  test('rejects leading slash', () => {
    expect(() => validateSlug('/people/john')).toThrow('Invalid slug');
  });

  test('rejects uppercase', () => {
    expect(() => validateSlug('People/John')).toThrow('Invalid slug');
  });

  test('rejects trailing slash', () => {
    expect(() => validateSlug('people/john/')).toThrow('Invalid slug');
    expect(() => validateSlug('a/')).toThrow('Invalid slug');
  });

  test('rejects consecutive slashes', () => {
    expect(() => validateSlug('people//john')).toThrow('Invalid slug');
  });
});

describe('contentHash', () => {
  test('returns consistent SHA-256 for same input', () => {
    const h1 = contentHash('truth', 'timeline');
    const h2 = contentHash('truth', 'timeline');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  test('different input produces different hash', () => {
    const h1 = contentHash('a', 'b');
    const h2 = contentHash('c', 'd');
    expect(h1).not.toBe(h2);
  });

  test('handles empty strings', () => {
    const h = contentHash('', '');
    expect(h).toHaveLength(64);
  });
});
