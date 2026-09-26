/**
 * `gbrain book-mirror --slug` validation (#13): kebab-case in any script.
 */

import { describe, expect, it } from 'bun:test';
import { validateBookSlug } from '../src/commands/book-mirror.ts';

describe('validateBookSlug', () => {
  it('accepts kebab-case slugs in any script and case', () => {
    expect(validateBookSlug('thinking-fast-and-slow')).toBe(true);
    expect(validateBookSlug('Dune-2')).toBe(true);
    expect(validateBookSlug('война-и-мир')).toBe(true);
    expect(validateBookSlug('Мастер-и-Маргарита')).toBe(true);
  });

  it('keeps the kebab-case rules for non-Latin slugs', () => {
    expect(validateBookSlug('-война')).toBe(false);
    expect(validateBookSlug('война/мир')).toBe(false);
    expect(validateBookSlug('война и мир')).toBe(false);
    expect(validateBookSlug('.война')).toBe(false);
    expect(validateBookSlug('война_мир')).toBe(false);
    expect(validateBookSlug('')).toBe(false);
  });
});
