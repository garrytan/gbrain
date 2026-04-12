import { describe, test, expect } from 'bun:test';
import { slugifySegment, slugifyPath } from '../src/core/sync.ts';

// Test the validateSlug behavior via the engine
// We can't import validateSlug directly (it's private), so we test through putPage mock behavior
// Instead, test the regex logic directly

function validateSlug(slug: string): boolean {
  // Mirrors the logic in postgres-engine.ts
  if (!slug || /(^|\/)\.\.($|\/)/.test(slug) || /^\//.test(slug)) return false;
  return true;
}

describe('slugifySegment', () => {
  test('converts spaces to hyphens', () => {
    expect(slugifySegment('hello world')).toBe('hello-world');
  });

  test('strips special characters', () => {
    expect(slugifySegment('notes (march 2024)')).toBe('notes-march-2024');
  });

  test('normalizes unicode accents', () => {
    expect(slugifySegment('caf\u00e9')).toBe('cafe');
  });

  test('collapses multiple hyphens', () => {
    expect(slugifySegment('a - b')).toBe('a-b');
  });

  test('strips leading and trailing hyphens', () => {
    expect(slugifySegment(' hello ')).toBe('hello');
  });

  test('preserves dots', () => {
    expect(slugifySegment('v1.0.0')).toBe('v1.0.0');
  });

  test('preserves underscores', () => {
    expect(slugifySegment('my_file_name')).toBe('my_file_name');
  });

  test('lowercases', () => {
    expect(slugifySegment('Apple Notes')).toBe('apple-notes');
  });

  test('returns empty for all-special-chars input', () => {
    expect(slugifySegment('!!!')).toBe('');
  });

  test('handles curly quotes and ellipsis', () => {
    expect(slugifySegment('she\u2026said \u201chello\u201d')).toBe('shesaid-hello');
  });
});

describe('slugifyPath', () => {
  test('slugifies each path segment independently', () => {
    expect(slugifyPath('Apple Notes/file name.md')).toBe('apple-notes/file-name');
  });

  test('already-valid slugs unchanged', () => {
    expect(slugifyPath('people/alice-smith.md')).toBe('people/alice-smith');
  });

  test('strips .md extension case-insensitively', () => {
    expect(slugifyPath('notes/file.MD')).toBe('notes/file');
  });

  test('strips .mdx extension', () => {
    expect(slugifyPath('components/hero.mdx')).toBe('components/hero');
    expect(slugifyPath('docs/guide.MDX')).toBe('docs/guide');
  });

  test('normalizes backslashes', () => {
    expect(slugifyPath('notes\\file.md')).toBe('notes/file');
  });

  test('strips leading ./', () => {
    expect(slugifyPath('./notes/file.md')).toBe('notes/file');
  });

  test('filters empty segments from all-special-chars dirs', () => {
    expect(slugifyPath('!!!/file.md')).toBe('file');
  });

  test('preserves dots in filenames', () => {
    expect(slugifyPath('notes/v1.0.0.md')).toBe('notes/v1.0.0');
  });

  test('handles consecutive slashes', () => {
    expect(slugifyPath('a//b.md')).toBe('a/b');
  });

  // Bug report example transformations
  test('Apple Notes example 1', () => {
    expect(slugifyPath('Apple Notes/2017-05-03 ohmygreen.md')).toBe('apple-notes/2017-05-03-ohmygreen');
  });

  test('Apple Notes example 2', () => {
    expect(slugifyPath('Apple Notes/2018-12-14 Team Photo.md')).toBe('apple-notes/2018-12-14-team-photo');
  });

  test('Apple Notes example 3 (parens and ellipsis)', () => {
    const input = 'Apple Notes/2017-05-05 Today I had a touch base with Kavita for the meeting on Monday. (she\u2026.md';
    const result = slugifyPath(input);
    expect(result).toBe('apple-notes/2017-05-05-today-i-had-a-touch-base-with-kavita-for-the-meeting-on-monday.-she');
  });

  test('meetings transcript example', () => {
    expect(slugifyPath('meetings/transcripts/2026-01-21 maria - california c4 collaboration discussion.md'))
      .toBe('meetings/transcripts/2026-01-21-maria-california-c4-collaboration-discussion');
  });
});

describe('validateSlug (widened for any filename chars)', () => {
  test('accepts clean slug', () => {
    expect(validateSlug('people/sarah-chen')).toBe(true);
  });

  test('accepts slug with spaces (Apple Notes)', () => {
    expect(validateSlug('apple-notes/2017-05-03 ohmygreen')).toBe(true);
  });

  test('accepts slug with parens', () => {
    expect(validateSlug('apple-notes/notes (march 2024)')).toBe(true);
  });

  test('accepts slug with special chars', () => {
    expect(validateSlug("notes/it's a test")).toBe(true);
    expect(validateSlug('notes/file@2024')).toBe(true);
    expect(validateSlug('notes/50% complete')).toBe(true);
  });

  test('accepts slug with unicode', () => {
    expect(validateSlug('notes/日本語テスト')).toBe(true);
    expect(validateSlug('notes/café-meeting')).toBe(true);
  });

  test('rejects empty slug', () => {
    expect(validateSlug('')).toBe(false);
  });

  test('rejects path traversal', () => {
    expect(validateSlug('../etc/passwd')).toBe(false);
    expect(validateSlug('notes/../../etc')).toBe(false);
  });

  test('rejects leading slash', () => {
    expect(validateSlug('/absolute/path')).toBe(false);
  });

  test('accepts slug with dots (not traversal)', () => {
    expect(validateSlug('notes/v1.0.0')).toBe(true);
    expect(validateSlug('notes/file.name.md')).toBe(true);
  });

  // Ellipsis false positive regression tests (PR #31)
  test('accepts slug with ellipsis (...)', () => {
    expect(validateSlug('ted-talks/i got 99 problems... palsy is just one')).toBe(true);
    expect(validateSlug('huberman-lab/how...works')).toBe(true);
    expect(validateSlug('multiple...dots...here')).toBe(true);
  });

  test('accepts slug with double dots in non-traversal positions', () => {
    expect(validateSlug('notes/v1..2')).toBe(true);
    expect(validateSlug('file..name')).toBe(true);
  });

  test('rejects bare .. as slug', () => {
    expect(validateSlug('..')).toBe(false);
  });

  test('rejects .. at start of path', () => {
    expect(validateSlug('../etc/passwd')).toBe(false);
  });

  test('rejects .. in middle of path', () => {
    expect(validateSlug('notes/../../etc')).toBe(false);
    expect(validateSlug('a/../b')).toBe(false);
  });

  test('rejects .. at end of path', () => {
    expect(validateSlug('notes/..')).toBe(false);
  });
});
