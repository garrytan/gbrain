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

describe('buildCanonicalNameSets — multi-source axis', () => {
  test('two sources same slug same name → brain-wide and per-source sets both populated', () => {
    const { sets, setsBySource, pageNames, pageNamesBySource } = buildCanonicalNameSets([
      { slug: 'people/alice-example', source_id: 'source-a', frontmatter: { name: 'Alice Example' } },
      { slug: 'people/alice-example', source_id: 'source-b', frontmatter: { name: 'Alice Example' } },
    ]);
    expect(sets.get('people/alice-example')!.has('alice example')).toBe(true);
    expect(setsBySource.get('source-a:people/alice-example')!.has('alice example')).toBe(true);
    expect(setsBySource.get('source-b:people/alice-example')!.has('alice example')).toBe(true);
    // Both sources agree → pageNames is identical regardless of winner.
    expect(pageNames.get('people/alice-example')).toBe('Alice Example');
    expect(pageNamesBySource.get('source-a:people/alice-example')).toBe('Alice Example');
    expect(pageNamesBySource.get('source-b:people/alice-example')).toBe('Alice Example');
  });

  test('two sources same slug different names → brain-wide set is the union; per-source sets stay distinct', () => {
    const { sets, setsBySource, pageNames, pageNamesBySource } = buildCanonicalNameSets([
      { slug: 'people/example', source_id: 'team-a', frontmatter: { name: 'Alpha Example' } },
      { slug: 'people/example', source_id: 'team-b', frontmatter: { name: 'Beta Example' } },
    ]);
    const brainWide = sets.get('people/example')!;
    // Brain-wide is the union: both names + first/last tokens of each.
    expect(brainWide.has('alpha example')).toBe(true);
    expect(brainWide.has('beta example')).toBe(true);
    expect(brainWide.has('alpha')).toBe(true);
    expect(brainWide.has('beta')).toBe(true);
    // Per-source stays distinct.
    expect(setsBySource.get('team-a:people/example')!.has('alpha example')).toBe(true);
    expect(setsBySource.get('team-a:people/example')!.has('beta example')).toBe(false);
    expect(setsBySource.get('team-b:people/example')!.has('beta example')).toBe(true);
    expect(setsBySource.get('team-b:people/example')!.has('alpha example')).toBe(false);
    // pageNames picks the alphabetically-first source_id deterministically.
    expect(pageNames.get('people/example')).toBe('Alpha Example');
    expect(pageNamesBySource.get('team-a:people/example')).toBe('Alpha Example');
    expect(pageNamesBySource.get('team-b:people/example')).toBe('Beta Example');
  });

  test('mixed valid + malformed across sources → slug is valid (one source has a name)', () => {
    const { sets, malformedSlugs, pageNames } = buildCanonicalNameSets([
      { slug: 'people/half-valid', source_id: 'source-a', frontmatter: {} },
      { slug: 'people/half-valid', source_id: 'source-b', frontmatter: { name: 'Half Valid' } },
    ]);
    expect(malformedSlugs.has('people/half-valid')).toBe(false);
    expect(sets.has('people/half-valid')).toBe(true);
    expect(pageNames.get('people/half-valid')).toBe('Half Valid');
  });

  test('all sources malformed → slug marked malformed', () => {
    const { sets, malformedSlugs } = buildCanonicalNameSets([
      { slug: 'people/bad-everywhere', source_id: 'source-a', frontmatter: {} },
      { slug: 'people/bad-everywhere', source_id: 'source-b', frontmatter: { name: '' } },
    ]);
    expect(sets.has('people/bad-everywhere')).toBe(false);
    expect(malformedSlugs.has('people/bad-everywhere')).toBe(true);
  });

  test('row without source_id defaults to "default" source key', () => {
    const { setsBySource } = buildCanonicalNameSets([
      { slug: 'people/no-source', frontmatter: { name: 'No Source' } },
    ]);
    expect(setsBySource.has('default:people/no-source')).toBe(true);
  });
});
