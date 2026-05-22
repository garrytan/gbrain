/**
 * Tests for frontmatter-inference.ts — the zero-friction ingest pipeline.
 *
 * Validates that files without frontmatter get correct type, title, date,
 * source, and tags inferred from their filesystem path and content.
 */

import { describe, test, expect } from 'bun:test';
import {
  inferFrontmatter,
  extractDateFromFilename,
  extractTitleFromFilename,
  extractTitleFromHeading,
  serializeFrontmatter,
  applyInference,
  DIRECTORY_RULES,
} from '../src/core/frontmatter-inference.ts';

// ── Date extraction ──────────────────────────────────────────────────

describe('extractDateFromFilename', () => {
  test('extracts YYYY-MM-DD from date-prefixed filename', () => {
    expect(extractDateFromFilename('2010-04-13 Apr 13 founders mtg.md')).toBe('2010-04-13');
  });

  test('extracts date with dash separator', () => {
    expect(extractDateFromFilename('2024-01-30-therapy-session.md')).toBe('2024-01-30');
  });

  test('extracts date with underscore separator', () => {
    expect(extractDateFromFilename('2023-06-15_meeting-notes.md')).toBe('2023-06-15');
  });

  test('returns null for no-date filename', () => {
    expect(extractDateFromFilename('README.md')).toBe(null);
  });

  test('returns null for filename with numbers but no date', () => {
    expect(extractDateFromFilename('chapter-1-intro.md')).toBe(null);
  });
});

// ── Title extraction ─────────────────────────────────────────────────

describe('extractTitleFromFilename', () => {
  test('strips date prefix and cleans up', () => {
    expect(extractTitleFromFilename('2010-04-13 Apr 13 founders mtg.md')).toBe('Apr 13 founders mtg');
  });

  test('strips YYYY-MM-DD- prefix', () => {
    expect(extractTitleFromFilename('2024-01-30-therapy-session.md')).toBe('Therapy Session');
  });

  test('handles filename without date', () => {
    expect(extractTitleFromFilename('cognitive-distortions.md')).toBe('Cognitive Distortions');
  });

  test('preserves mixed case', () => {
    expect(extractTitleFromFilename('YC presidency.md')).toBe('YC presidency');
  });

  test('returns Untitled for empty result', () => {
    expect(extractTitleFromFilename('.md')).toBe('Untitled');
  });
});

describe('extractTitleFromHeading', () => {
  test('extracts first # heading', () => {
    expect(extractTitleFromHeading('# Dhravya Shah\n\n> Founder of Supermemory')).toBe('Dhravya Shah');
  });

  test('ignores ## headings', () => {
    expect(extractTitleFromHeading('Some text\n## Not this\n# This one')).toBe('This one');
  });

  test('returns null when no heading found', () => {
    expect(extractTitleFromHeading('Just some text\nwithout headings')).toBe(null);
  });

  test('looks within first 20 lines only', () => {
    const lines = Array(25).fill('text').join('\n') + '\n# Too Late';
    expect(extractTitleFromHeading(lines)).toBe(null);
  });
});

// ── Core inference ───────────────────────────────────────────────────

describe('inferFrontmatter', () => {
  test('skips files that already have frontmatter', () => {
    const result = inferFrontmatter('people/alice.md', '---\ntitle: Alice\n---\n# Alice');
    expect(result.skipped).toBe(true);
  });

  test('Apple Notes: infers type, date, title, source', () => {
    const result = inferFrontmatter(
      'Apple Notes/2010-04-13 Apr 13 founders mtg.md',
      '<span style="color:#000ff;">Top priority</span>',
    );
    expect(result.type).toBe('apple-note');
    expect(result.date).toBe('2010-04-13');
    expect(result.title).toBe('Apr 13 founders mtg');
    expect(result.source).toBe('apple-notes');
  });

  test('Apple Notes/YC: adds yc tag', () => {
    const result = inferFrontmatter(
      'Apple Notes/YC/2022-08-04 Project 1783Y.md',
      'Some content',
    );
    expect(result.type).toBe('apple-note');
    expect(result.tags).toContain('yc');
    expect(result.date).toBe('2022-08-04');
  });

  test('Apple Notes/Politics: adds politics tag', () => {
    const result = inferFrontmatter(
      'Apple Notes/Politics/2023-11-15 DA race notes.md',
      'Some content',
    );
    expect(result.tags).toContain('politics');
  });

  test('people/ directory: type person, title from heading', () => {
    const result = inferFrontmatter(
      'people/dhravya-shah.md',
      '# Dhravya Shah\n\n> Founder of Supermemory',
    );
    expect(result.type).toBe('person');
    expect(result.title).toBe('Dhravya Shah');
  });

  test('people/ directory: falls back to filename when no heading', () => {
    const result = inferFrontmatter(
      'people/john-doe.md',
      'Some text without a heading',
    );
    expect(result.type).toBe('person');
    expect(result.title).toBe('John Doe');
  });

  test('personal/therapy: infers therapy-session type with date', () => {
    const result = inferFrontmatter(
      'personal/therapy/jan/2024-01-30.md',
      'Session notes...',
    );
    expect(result.type).toBe('therapy-session');
    expect(result.date).toBe('2024-01-30');
    expect(result.source).toBe('therapy');
  });

  test('personal/reflections: infers reflection type, title from heading', () => {
    const result = inferFrontmatter(
      'personal/reflections/cognitive-distortions.md',
      '# Cognitive Distortions\n\nA list of common...',
    );
    expect(result.type).toBe('reflection');
    expect(result.title).toBe('Cognitive Distortions');
  });

  test('writing/essays: infers essay type', () => {
    const result = inferFrontmatter(
      'writing/essays/2024-03-15-on-being-remembered.md',
      '# On Being Remembered Forever\n\nSome thoughts...',
    );
    expect(result.type).toBe('essay');
    expect(result.title).toBe('On Being Remembered Forever');
    expect(result.date).toBe('2024-03-15');
  });

  test('daily/calendar: infers calendar-index type', () => {
    const result = inferFrontmatter(
      'daily/calendar/2026-01-15-yc-office-hours.md',
      '# Calendar Index\nSome calendar data',
    );
    expect(result.type).toBe('calendar-index');
    expect(result.source).toBe('calendar');
  });

  test('companies/ directory: type company', () => {
    const result = inferFrontmatter(
      'companies/stripe.md',
      '# Stripe\n\n> Online payments infrastructure',
    );
    expect(result.type).toBe('company');
    expect(result.title).toBe('Stripe');
  });

  test('unknown directory: defaults to note type with heading title', () => {
    const result = inferFrontmatter(
      'random/some-file.md',
      '# My Random Notes\n\nStuff here',
    );
    expect(result.type).toBe('note');
    expect(result.title).toBe('My Random Notes');
  });

  test('handles empty content', () => {
    const result = inferFrontmatter('notes/empty.md', '');
    expect(result.type).toBe('note');
    expect(result.title).toBe('Empty');
  });
});

// ── Serialization ────────────────────────────────────────────────────

describe('serializeFrontmatter', () => {
  test('generates valid YAML frontmatter', () => {
    const fm = serializeFrontmatter({
      title: 'Apr 13 founders mtg',
      type: 'apple-note',
      date: '2010-04-13',
      source: 'apple-notes',
      tags: ['yc'],
    });
    expect(fm).toContain('---');
    expect(fm).toContain('title: Apr 13 founders mtg');
    expect(fm).toContain('type: apple-note');
    expect(fm).toContain('date: "2010-04-13"');
    expect(fm).toContain('source: apple-notes');
    expect(fm).toContain('tags: ["yc"]');
  });

  test('quotes title with special chars', () => {
    const fm = serializeFrontmatter({
      title: 'What\'s the deal: a "primer"',
      type: 'note',
    });
    expect(fm).toContain('title: "What\'s the deal: a \\"primer\\""');
  });

  test('returns empty string for skipped files', () => {
    expect(serializeFrontmatter({ title: '', type: '', skipped: true })).toBe('');
  });

  test('omits optional fields when absent', () => {
    const fm = serializeFrontmatter({ title: 'Test', type: 'note' });
    expect(fm).not.toContain('date');
    expect(fm).not.toContain('source');
    expect(fm).not.toContain('tags');
  });
});

// ── Integration ──────────────────────────────────────────────────────

describe('applyInference', () => {
  test('prepends frontmatter to content without it', () => {
    const { content, inferred } = applyInference(
      'people/alice-smith.md',
      '# Alice Smith\n\n> Founder of FooBar',
    );
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('type: person');
    expect(content).toContain('title: Alice Smith');
    expect(content).toContain('# Alice Smith');
    expect(inferred.skipped).toBeUndefined();
  });

  test('returns original content for files with frontmatter', () => {
    const original = '---\ntitle: Bob\n---\n# Bob';
    const { content, inferred } = applyInference('people/bob.md', original);
    expect(content).toBe(original);
    expect(inferred.skipped).toBe(true);
  });
});

// ── Rules coverage ───────────────────────────────────────────────────

describe('DIRECTORY_RULES', () => {
  test('has a catch-all rule with empty prefix', () => {
    const catchAll = DIRECTORY_RULES.find(r => r.pathPrefix === '');
    expect(catchAll).toBeDefined();
    expect(catchAll!.type).toBe('note');
  });

  test('Apple Notes rules are more specific than the catch-all', () => {
    const appleRules = DIRECTORY_RULES.filter(r => r.pathPrefix.startsWith('apple notes/'));
    expect(appleRules.length).toBeGreaterThan(1); // subfolder rules + catch-all
    // Subfolder rules should come before the generic apple notes/ rule
    const ycIdx = DIRECTORY_RULES.findIndex(r => r.pathPrefix === 'apple notes/yc/');
    const genericIdx = DIRECTORY_RULES.findIndex(r => r.pathPrefix === 'apple notes/');
    expect(ycIdx).toBeLessThan(genericIdx);
  });
});
