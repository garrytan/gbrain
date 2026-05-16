import { describe, test, expect } from 'bun:test';
import {
  buildCanonicalNameSets,
  findOccurrences,
  classifyOccurrences,
  type CanonicalNameSets,
} from '../src/core/audit-name-links.ts';

function build(rows: Array<{ slug: string; frontmatter: Record<string, unknown> }>) {
  return buildCanonicalNameSets(rows);
}

describe('findOccurrences', () => {
  test('captures byte offsets for a markdown link', () => {
    const content = 'Hello [Calvin Waytek](people/cwaytek-aseva) world.';
    const occs = findOccurrences(content, 'fixture.md');
    expect(occs).toHaveLength(1);
    const occ = occs[0];
    expect(occ.slug).toBe('people/cwaytek-aseva');
    expect(occ.display).toBe('Calvin Waytek');
    expect(occ.linkForm).toBe('markdown');
    // 'Hello ' is 6 bytes; '[' begins at index 6.
    expect(occ.matchStart).toBe(6);
    // 'C' of Calvin sits at matchStart + 1 = 7.
    expect(occ.displayStart).toBe(7);
    // 13-char display, end exclusive.
    expect(occ.displayEnd).toBe(7 + 'Calvin Waytek'.length);
    expect(content.slice(occ.displayStart, occ.displayEnd)).toBe('Calvin Waytek');
    expect(occ.line).toBe(1);
  });

  test('captures byte offsets for a qualified wikilink', () => {
    const content = 'Talk: [[wiki:people/cwaytek-aseva|Calvin]] said hi.';
    const occs = findOccurrences(content, 'fixture.md');
    expect(occs).toHaveLength(1);
    const occ = occs[0];
    expect(occ.slug).toBe('people/cwaytek-aseva');
    expect(occ.display).toBe('Calvin');
    expect(occ.linkForm).toBe('wikilink');
    expect(content.slice(occ.displayStart, occ.displayEnd)).toBe('Calvin');
  });

  test('captures byte offsets for an unqualified wikilink', () => {
    const content = 'Hi [[people/cwaytek-aseva|Calvin]] said hi.';
    const occs = findOccurrences(content, 'fixture.md');
    expect(occs).toHaveLength(1);
    const occ = occs[0];
    expect(occ.slug).toBe('people/cwaytek-aseva');
    expect(occ.display).toBe('Calvin');
    expect(occ.linkForm).toBe('wikilink');
    expect(content.slice(occ.displayStart, occ.displayEnd)).toBe('Calvin');
  });

  test('strips .md suffix from slug', () => {
    const content = '[Calvin](people/cwaytek-aseva.md)';
    const occs = findOccurrences(content, 'fixture.md');
    expect(occs).toHaveLength(1);
    expect(occs[0].slug).toBe('people/cwaytek-aseva');
  });

  test('strips leading ./ and ../ from slug', () => {
    const c1 = '[Calvin](./people/cwaytek-aseva)';
    const o1 = findOccurrences(c1, 'fixture.md');
    expect(o1[0].slug).toBe('people/cwaytek-aseva');

    const c2 = '[Calvin](../people/cwaytek-aseva.md)';
    const o2 = findOccurrences(c2, 'fixture.md');
    expect(o2[0].slug).toBe('people/cwaytek-aseva');
  });

  test('skips inline-code blocks (single backticks)', () => {
    const content = 'See `[Calvin Waytek](people/cwaytek-aseva)` example.';
    const occs = findOccurrences(content, 'fixture.md');
    expect(occs).toHaveLength(0);
  });

  test('skips fenced code blocks (triple backticks)', () => {
    const content = [
      'before',
      '```',
      '[Calvin Waytek](people/cwaytek-aseva)',
      '```',
      'after',
    ].join('\n');
    const occs = findOccurrences(content, 'fixture.md');
    expect(occs).toHaveLength(0);
  });

  test('skips YAML frontmatter', () => {
    const content = [
      '---',
      'title: foo',
      'related: "[Calvin](people/cwaytek-aseva)"',
      '---',
      '',
      'body',
    ].join('\n');
    const occs = findOccurrences(content, 'fixture.md');
    expect(occs).toHaveLength(0);
  });

  test('computes line numbers correctly', () => {
    const content = 'line 1\nline 2\n[Calvin Waytek](people/cwaytek-aseva)\nline 4';
    const occs = findOccurrences(content, 'fixture.md');
    expect(occs).toHaveLength(1);
    expect(occs[0].line).toBe(3);
  });

  test('finds multiple links on the same line', () => {
    const content = '[Jessie](people/jbryan-aseva) and [Justin](people/jthompson-aseva).';
    const occs = findOccurrences(content, 'fixture.md');
    expect(occs).toHaveLength(2);
    expect(occs[0].slug).toBe('people/jbryan-aseva');
    expect(occs[1].slug).toBe('people/jthompson-aseva');
  });

  test('ignores non-people slug roots', () => {
    const content = '[Sansay](companies/sansay)';
    const occs = findOccurrences(content, 'fixture.md');
    expect(occs).toHaveLength(0);
  });
});

describe('classifyOccurrences', () => {
  const rows = [
    { slug: 'people/cwaytek-aseva', frontmatter: { name: 'Christopher Waytek', linkify_aliases: ['Chris'] } },
    { slug: 'people/jthompson-aseva', frontmatter: { name: 'Justin Thompson' } },
    { slug: 'people/no-name', frontmatter: {} },
  ];
  const { sets, malformedSlugs } = build(rows);

  test('happy path: legitimate display → no mismatch', () => {
    const occs = findOccurrences('Hi [Christopher Waytek](people/cwaytek-aseva).', 'f.md');
    const out = classifyOccurrences(occs, sets, malformedSlugs);
    expect(out).toHaveLength(0);
  });

  test('happy path: derived first-token alias → no mismatch', () => {
    const occs = findOccurrences('Hi [Justin](people/jthompson-aseva).', 'f.md');
    const out = classifyOccurrences(occs, sets, malformedSlugs);
    expect(out).toHaveLength(0);
  });

  test('happy path: linkify_aliases entry → no mismatch', () => {
    const occs = findOccurrences('Hi [Chris](people/cwaytek-aseva).', 'f.md');
    const out = classifyOccurrences(occs, sets, malformedSlugs);
    expect(out).toHaveLength(0);
  });

  test('Mode 1: display mismatch → name_mismatch with canonical names', () => {
    const occs = findOccurrences('Hi [Calvin Waytek](people/cwaytek-aseva).', 'f.md');
    const out = classifyOccurrences(occs, sets, malformedSlugs);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('name_mismatch');
    expect(out[0].slug).toBe('people/cwaytek-aseva');
    expect(out[0].display).toBe('Calvin Waytek');
    expect(out[0].canonicalNames).toEqual(out[0].canonicalNames.slice().sort());
    expect(out[0].canonicalNames).toContain('chris');
    expect(out[0].canonicalNames).toContain('christopher');
    expect(out[0].canonicalNames).toContain('christopher waytek');
    expect(out[0].canonicalNames).toContain('waytek');
    expect(out[0].occurrences).toBe(1);
  });

  test('Mode 2: unknown slug → unknown_target', () => {
    const occs = findOccurrences('Hi [Leedy Allen](people/lallen-aseva).', 'f.md');
    const out = classifyOccurrences(occs, sets, malformedSlugs);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('unknown_target');
    expect(out[0].slug).toBe('people/lallen-aseva');
    expect(out[0].canonicalNames).toEqual([]);
  });

  test('malformed: page exists but lacks name → malformed_target with reason', () => {
    const occs = findOccurrences('Hi [Anything](people/no-name).', 'f.md');
    const out = classifyOccurrences(occs, sets, malformedSlugs);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('malformed_target');
    expect(out[0].slug).toBe('people/no-name');
    expect(out[0].malformedReason).toBeDefined();
    expect(out[0].malformedReason!.length).toBeGreaterThan(0);
  });

  test('skip-zone: link inside inline code → no diagnostic', () => {
    const occs = findOccurrences('Example: `[Calvin Waytek](people/cwaytek-aseva)` ok.', 'f.md');
    const out = classifyOccurrences(occs, sets, malformedSlugs);
    expect(out).toHaveLength(0);
  });

  test('skip-zone: link inside fenced code → no diagnostic', () => {
    const content = '```\n[Calvin Waytek](people/cwaytek-aseva)\n```';
    const occs = findOccurrences(content, 'f.md');
    const out = classifyOccurrences(occs, sets, malformedSlugs);
    expect(out).toHaveLength(0);
  });

  test('wikilink form: qualified [[wiki:people/Y|Calvin]] → name_mismatch like markdown form', () => {
    const occs = findOccurrences('See [[wiki:people/cwaytek-aseva|Calvin]] said.', 'f.md');
    const out = classifyOccurrences(occs, sets, malformedSlugs);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('name_mismatch');
    expect(out[0].linkForm).toBe('wikilink');
    expect(out[0].display).toBe('Calvin');
  });

  test('wikilink form: unqualified [[people/Y|Calvin]] → name_mismatch', () => {
    const occs = findOccurrences('See [[people/cwaytek-aseva|Calvin]] said.', 'f.md');
    const out = classifyOccurrences(occs, sets, malformedSlugs);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('name_mismatch');
    expect(out[0].linkForm).toBe('wikilink');
    expect(out[0].display).toBe('Calvin');
  });

  test('dedup: same (slug, display) twice → one diagnostic, occurrences=2, first line preserved', () => {
    const content = [
      'line 1',
      '[Calvin Waytek](people/cwaytek-aseva)',
      'line 3',
      '[Calvin Waytek](people/cwaytek-aseva)',
    ].join('\n');
    const occs = findOccurrences(content, 'f.md');
    const out = classifyOccurrences(occs, sets, malformedSlugs);
    expect(out).toHaveLength(1);
    expect(out[0].occurrences).toBe(2);
    expect(out[0].line).toBe(2);  // first occurrence's line preserved
  });

  test('dedup: distinct displays for same slug → two diagnostics', () => {
    const content = '[Calvin](people/cwaytek-aseva) and [Calvin Waytek](people/cwaytek-aseva).';
    const occs = findOccurrences(content, 'f.md');
    const out = classifyOccurrences(occs, sets, malformedSlugs);
    expect(out).toHaveLength(2);
  });

  test('case folding: display "JUSTIN" matches first-token "justin" → no mismatch', () => {
    const occs = findOccurrences('Hi [JUSTIN](people/jthompson-aseva).', 'f.md');
    const out = classifyOccurrences(occs, sets, malformedSlugs);
    expect(out).toHaveLength(0);
  });

  test('case-mixed display "ChRiStOpHeR" still validates', () => {
    const occs = findOccurrences('Hi [ChRiStOpHeR](people/cwaytek-aseva).', 'f.md');
    const out = classifyOccurrences(occs, sets, malformedSlugs);
    expect(out).toHaveLength(0);
  });

  test('empty input → empty output', () => {
    const empty: CanonicalNameSets = new Map();
    const out = classifyOccurrences([], empty, new Map());
    expect(out).toEqual([]);
  });
});

describe('classifyOccurrences — source-axis routing', () => {
  test('qualified wikilink validates against the matching source-specific set', () => {
    const { sets, setsBySource, malformedSlugs } = buildCanonicalNameSets([
      { slug: 'people/example', source_id: 'team-a', frontmatter: { name: 'Alpha Example' } },
      { slug: 'people/example', source_id: 'team-b', frontmatter: { name: 'Beta Example' } },
    ]);
    // [[team-a:people/example|Alpha]] matches team-a (alpha is first-token).
    const occsA = findOccurrences('See [[team-a:people/example|Alpha]].', 'f.md');
    const outA = classifyOccurrences(occsA, sets, malformedSlugs, setsBySource);
    expect(outA).toHaveLength(0);

    // [[team-b:people/example|Beta]] matches team-b.
    const occsB = findOccurrences('See [[team-b:people/example|Beta]].', 'f.md');
    const outB = classifyOccurrences(occsB, sets, malformedSlugs, setsBySource);
    expect(outB).toHaveLength(0);
  });

  test('qualified wikilink with mismatched source displays a name_mismatch (per-source set is strict)', () => {
    const { sets, setsBySource, malformedSlugs } = buildCanonicalNameSets([
      { slug: 'people/example', source_id: 'team-a', frontmatter: { name: 'Alpha Example' } },
      { slug: 'people/example', source_id: 'team-b', frontmatter: { name: 'Beta Example' } },
    ]);
    // [[team-a:people/example|Beta]] — team-a's set does NOT contain "beta".
    // Per-source lookup wins; fallback to brain-wide is only used when the
    // source has no row for the slug. Here team-a has its own row, so beta
    // surfaces as a name_mismatch even though brain-wide would accept it.
    const occs = findOccurrences('See [[team-a:people/example|Beta]].', 'f.md');
    const out = classifyOccurrences(occs, sets, malformedSlugs, setsBySource);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('name_mismatch');
    expect(out[0].canonicalNames).toContain('alpha example');
    expect(out[0].canonicalNames).not.toContain('beta example');
  });

  test('unqualified wikilink uses brain-wide union (matches either source name)', () => {
    const { sets, setsBySource, malformedSlugs } = buildCanonicalNameSets([
      { slug: 'people/example', source_id: 'team-a', frontmatter: { name: 'Alpha Example' } },
      { slug: 'people/example', source_id: 'team-b', frontmatter: { name: 'Beta Example' } },
    ]);
    // Brain-wide union: both alpha and beta are legitimate.
    const occsA = findOccurrences('See [[people/example|Alpha]].', 'f.md');
    expect(classifyOccurrences(occsA, sets, malformedSlugs, setsBySource)).toHaveLength(0);
    const occsB = findOccurrences('See [[people/example|Beta]].', 'f.md');
    expect(classifyOccurrences(occsB, sets, malformedSlugs, setsBySource)).toHaveLength(0);
  });

  test('qualified wikilink with unknown source falls through to brain-wide', () => {
    const { sets, setsBySource, malformedSlugs } = buildCanonicalNameSets([
      { slug: 'people/example', source_id: 'team-a', frontmatter: { name: 'Alpha Example' } },
    ]);
    // [[stale-source:people/example|Alpha]] — stale-source has no row for
    // this slug. Per the policy, fall through to brain-wide.
    const occs = findOccurrences('See [[stale-source:people/example|Alpha]].', 'f.md');
    const out = classifyOccurrences(occs, sets, malformedSlugs, setsBySource);
    expect(out).toHaveLength(0);
  });
});
