import { describe, test, expect } from 'bun:test';
import {
  buildCanonicalNameSets,
  findOccurrences,
  classifyOccurrences,
  applyDisplayFixes,
} from '../src/core/audit-name-links.ts';

const rows = [
  { slug: 'people/cwaytek-aseva', frontmatter: { name: 'Christopher Waytek', linkify_aliases: ['Chris'] } },
  { slug: 'people/jthompson-aseva', frontmatter: { name: 'Justin Thompson' } },
  { slug: 'people/no-name', frontmatter: {} },
];
const { sets, pageNames, malformedSlugs } = buildCanonicalNameSets(rows);

describe('applyDisplayFixes', () => {
  test('Mode 1: rewrites markdown display to page canonical name', () => {
    const content = 'Hi [Calvin Waytek](people/cwaytek-aseva) said.';
    const occs = findOccurrences(content, 'f.md');
    const mismatches = classifyOccurrences(occs, sets, malformedSlugs);
    const { newContent, appliedFixes } = applyDisplayFixes(content, occs, mismatches, pageNames);
    expect(newContent).toBe('Hi [Christopher Waytek](people/cwaytek-aseva) said.');
    expect(appliedFixes).toHaveLength(1);
    expect(appliedFixes[0]).toEqual({
      slug: 'people/cwaytek-aseva',
      oldDisplay: 'Calvin Waytek',
      newDisplay: 'Christopher Waytek',
      line: 1,
      linkForm: 'markdown',
    });
  });

  test('Mode 1: rewrites qualified wikilink display to canonical name', () => {
    const content = 'Hi [[wiki:people/cwaytek-aseva|Calvin]] said.';
    const occs = findOccurrences(content, 'f.md');
    const mismatches = classifyOccurrences(occs, sets, malformedSlugs);
    const { newContent, appliedFixes } = applyDisplayFixes(content, occs, mismatches, pageNames);
    expect(newContent).toBe('Hi [[wiki:people/cwaytek-aseva|Christopher Waytek]] said.');
    expect(appliedFixes).toHaveLength(1);
    expect(appliedFixes[0].linkForm).toBe('wikilink');
    expect(appliedFixes[0].oldDisplay).toBe('Calvin');
    expect(appliedFixes[0].newDisplay).toBe('Christopher Waytek');
  });

  test('Mode 1: rewrites unqualified wikilink display to canonical name', () => {
    const content = 'Hi [[people/cwaytek-aseva|Calvin]] said.';
    const occs = findOccurrences(content, 'f.md');
    const mismatches = classifyOccurrences(occs, sets, malformedSlugs);
    const { newContent, appliedFixes } = applyDisplayFixes(content, occs, mismatches, pageNames);
    expect(newContent).toBe('Hi [[people/cwaytek-aseva|Christopher Waytek]] said.');
    expect(appliedFixes).toHaveLength(1);
    expect(appliedFixes[0].linkForm).toBe('wikilink');
  });

  test('Mode 2 (unknown_target): NOT rewritten', () => {
    const content = 'Hi [Leedy Allen](people/lallen-aseva) said.';
    const occs = findOccurrences(content, 'f.md');
    const mismatches = classifyOccurrences(occs, sets, malformedSlugs);
    const { newContent, appliedFixes } = applyDisplayFixes(content, occs, mismatches, pageNames);
    expect(newContent).toBe(content);
    expect(appliedFixes).toHaveLength(0);
  });

  test('Mode 2 (malformed_target): NOT rewritten', () => {
    const content = 'Hi [Anything](people/no-name) said.';
    const occs = findOccurrences(content, 'f.md');
    const mismatches = classifyOccurrences(occs, sets, malformedSlugs);
    const { newContent, appliedFixes } = applyDisplayFixes(content, occs, mismatches, pageNames);
    expect(newContent).toBe(content);
    expect(appliedFixes).toHaveLength(0);
  });

  test('mixed file: Mode 1 rewritten, Mode 2 untouched', () => {
    const content = [
      '[Calvin Waytek](people/cwaytek-aseva) met [Leedy Allen](people/lallen-aseva).',
    ].join('\n');
    const occs = findOccurrences(content, 'f.md');
    const mismatches = classifyOccurrences(occs, sets, malformedSlugs);
    const { newContent, appliedFixes } = applyDisplayFixes(content, occs, mismatches, pageNames);
    expect(newContent).toBe('[Christopher Waytek](people/cwaytek-aseva) met [Leedy Allen](people/lallen-aseva).');
    expect(appliedFixes).toHaveLength(1);
    expect(appliedFixes[0].slug).toBe('people/cwaytek-aseva');
  });

  test('multiple Mode-1 rewrites in one file: all applied with correct offset handling', () => {
    const content = '[Calvin](people/cwaytek-aseva) and [Calvin Waytek](people/cwaytek-aseva).';
    const occs = findOccurrences(content, 'f.md');
    const mismatches = classifyOccurrences(occs, sets, malformedSlugs);
    const { newContent, appliedFixes } = applyDisplayFixes(content, occs, mismatches, pageNames);
    expect(newContent).toBe('[Christopher Waytek](people/cwaytek-aseva) and [Christopher Waytek](people/cwaytek-aseva).');
    expect(appliedFixes).toHaveLength(2);
    // Reported in source order.
    expect(appliedFixes[0].oldDisplay).toBe('Calvin');
    expect(appliedFixes[1].oldDisplay).toBe('Calvin Waytek');
  });

  test('idempotency: re-running on already-fixed content is a no-op', () => {
    const original = 'Hi [Calvin Waytek](people/cwaytek-aseva) said.';
    const occs1 = findOccurrences(original, 'f.md');
    const mm1 = classifyOccurrences(occs1, sets, malformedSlugs);
    const { newContent: pass1 } = applyDisplayFixes(original, occs1, mm1, pageNames);

    const occs2 = findOccurrences(pass1, 'f.md');
    const mm2 = classifyOccurrences(occs2, sets, malformedSlugs);
    const { newContent: pass2, appliedFixes: fixes2 } = applyDisplayFixes(pass1, occs2, mm2, pageNames);

    expect(pass2).toBe(pass1);
    expect(fixes2).toHaveLength(0);
  });

  test('different Mode 1 mismatches across same line splice cleanly', () => {
    const content = '[A](people/cwaytek-aseva) ... [B](people/jthompson-aseva)';
    const occs = findOccurrences(content, 'f.md');
    const mismatches = classifyOccurrences(occs, sets, malformedSlugs);
    const { newContent, appliedFixes } = applyDisplayFixes(content, occs, mismatches, pageNames);
    expect(newContent).toBe('[Christopher Waytek](people/cwaytek-aseva) ... [Justin Thompson](people/jthompson-aseva)');
    expect(appliedFixes).toHaveLength(2);
  });

  test('legitimate display: no fix applied even when same slug elsewhere needs fixing', () => {
    const content = '[Christopher](people/cwaytek-aseva) said [Calvin](people/cwaytek-aseva).';
    const occs = findOccurrences(content, 'f.md');
    const mismatches = classifyOccurrences(occs, sets, malformedSlugs);
    const { newContent, appliedFixes } = applyDisplayFixes(content, occs, mismatches, pageNames);
    // 'Christopher' is a valid alias; 'Calvin' is not.
    expect(newContent).toBe('[Christopher](people/cwaytek-aseva) said [Christopher Waytek](people/cwaytek-aseva).');
    expect(appliedFixes).toHaveLength(1);
    expect(appliedFixes[0].oldDisplay).toBe('Calvin');
  });

  test('empty inputs: no-op', () => {
    const { newContent, appliedFixes } = applyDisplayFixes('', [], [], pageNames);
    expect(newContent).toBe('');
    expect(appliedFixes).toHaveLength(0);
  });
});
