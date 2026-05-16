import { describe, test, expect } from 'bun:test';
import { buildCanonicalNameSets } from '../src/core/audit-name-links.ts';

describe('buildCanonicalNameSets', () => {
  test('derives full + first + last token set from name', () => {
    const { sets, pageNames } = buildCanonicalNameSets([
      { slug: 'people/jthompson-aseva', frontmatter: { name: 'Justin Thompson' } },
    ]);
    const set = sets.get('people/jthompson-aseva')!;
    expect(set.has('justin thompson')).toBe(true);
    expect(set.has('justin')).toBe(true);
    expect(set.has('thompson')).toBe(true);
    expect(pageNames.get('people/jthompson-aseva')).toBe('Justin Thompson');
  });

  test('includes linkify_aliases entries', () => {
    const { sets } = buildCanonicalNameSets([
      { slug: 'people/cwaytek-aseva', frontmatter: { name: 'Christopher Waytek', linkify_aliases: ['Chris'] } },
    ]);
    expect(sets.get('people/cwaytek-aseva')!.has('chris')).toBe(true);
  });

  test('expands apostrophe variants', () => {
    const { sets } = buildCanonicalNameSets([
      { slug: 'people/obrien-foo', frontmatter: { name: "Joe O'Brien" } },
    ]);
    const set = sets.get('people/obrien-foo')!;
    expect(set.has("o'brien")).toBe(true);
    expect(set.has("o’brien")).toBe(true);  // U+2019
  });

  test('frontmatter missing name → malformedSlugs entry', () => {
    const { sets, malformedSlugs } = buildCanonicalNameSets([
      { slug: 'people/no-name', frontmatter: {} },
    ]);
    expect(sets.has('people/no-name')).toBe(false);
    expect(malformedSlugs.get('people/no-name')).toBeDefined();
  });

  test('single-token name does not add a separate last-token entry', () => {
    const { sets } = buildCanonicalNameSets([
      { slug: 'people/cher', frontmatter: { name: 'Cher' } },
    ]);
    const set = sets.get('people/cher')!;
    expect(set.has('cher')).toBe(true);
    // Single-token case: full name and first-token are the same; no extra last-token entry.
    expect(set.size).toBe(1);
  });

  test('pageNames preserves original case (not case-folded)', () => {
    const { pageNames } = buildCanonicalNameSets([
      { slug: 'people/cwaytek-aseva', frontmatter: { name: 'Christopher Waytek' } },
    ]);
    expect(pageNames.get('people/cwaytek-aseva')).toBe('Christopher Waytek');
  });

  test('linkify_aliases with apostrophe variants', () => {
    const { sets } = buildCanonicalNameSets([
      { slug: 'people/x', frontmatter: { name: 'X Y', linkify_aliases: ["D'Arcy"] } },
    ]);
    const set = sets.get('people/x')!;
    expect(set.has("d'arcy")).toBe(true);
    expect(set.has("d’arcy")).toBe(true);
  });

  test('non-string name (number) → malformedSlugs entry', () => {
    const { sets, malformedSlugs } = buildCanonicalNameSets([
      { slug: 'people/bogus', frontmatter: { name: 42 } },
    ]);
    expect(sets.has('people/bogus')).toBe(false);
    expect(malformedSlugs.get('people/bogus')).toBeDefined();
  });

  test('whitespace-only name → malformedSlugs entry', () => {
    const { sets, malformedSlugs } = buildCanonicalNameSets([
      { slug: 'people/blank', frontmatter: { name: '   ' } },
    ]);
    expect(sets.has('people/blank')).toBe(false);
    expect(malformedSlugs.get('people/blank')).toBeDefined();
  });
});
