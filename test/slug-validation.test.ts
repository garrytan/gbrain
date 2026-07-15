import { describe, test, expect } from 'bun:test';
import { slugifySegment, slugifyPath, SLUG_SEGMENT_PATTERN } from '../src/core/sync.ts';

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

describe('CJK slug preservation (v0.32.7)', () => {
  test('Han characters preserved (Chinese)', () => {
    expect(slugifySegment('品牌圣经')).toBe('品牌圣经');
    expect(slugifySegment('销售论证文档')).toBe('销售论证文档');
  });

  test('Hiragana preserved', () => {
    expect(slugifySegment('ひらがなテスト')).toBe('ひらがなテスト');
  });

  test('Katakana preserved (full-width)', () => {
    expect(slugifySegment('カタカナテスト')).toBe('カタカナテスト');
  });

  test('Hangul Syllables preserved (Korean)', () => {
    expect(slugifySegment('한글테스트')).toBe('한글테스트');
  });

  test('NFC re-composition for Hangul', () => {
    // NFD decomposes Hangul Syllables into conjoining Jamo (U+1100 block).
    // Without normalize('NFC') after the accent strip, the result would
    // collapse to empty because Jamo sits outside the Syllables range.
    const decomposed = '한글테스트'.normalize('NFD');
    expect(slugifySegment(decomposed)).toBe('한글테스트');
  });

  test('mixed CJK + ASCII: lowercase ASCII, preserve CJK', () => {
    expect(slugifySegment('ICP-理想客户画像')).toBe('icp-理想客户画像');
  });

  test('collision regression: different CJK names produce different slugs', () => {
    expect(slugifySegment('品牌圣经')).not.toBe(slugifySegment('销售论证文档'));
  });

  test('slugifyPath preserves pure-CJK files', () => {
    expect(slugifyPath('inbox/品牌圣经.md')).toBe('inbox/品牌圣经');
  });

  test('slugifyPath collision regression at path level', () => {
    expect(slugifyPath('inbox/品牌圣经.md')).not.toBe(slugifyPath('inbox/销售论证文档.md'));
  });

  test('CJK directory names preserved', () => {
    expect(slugifyPath('档案/2024-记录.md')).toBe('档案/2024-记录');
  });

  test('REGRESSION: café still slugifies to cafe (NFD-strip-accents chain preserved)', () => {
    // Iron rule: the NFC re-normalize must not break existing Latin-with-accent
    // behavior. café (Latin) decomposes to 'cafe' + combining acute under NFD,
    // strip-combining drops the acute, NFC recomposes 'cafe', then lowercase.
    expect(slugifySegment('café')).toBe('cafe');
  });

  test('REGRESSION: existing English slugs unchanged', () => {
    expect(slugifySegment('hello world')).toBe('hello-world');
    expect(slugifySegment('notes (march 2024)')).toBe('notes-march-2024');
  });
});

describe('SLUG_SEGMENT_PATTERN (v0.32.7)', () => {
  test('matches pure-CJK slug segments', () => {
    expect(SLUG_SEGMENT_PATTERN.test('品牌圣经')).toBe(true);
    expect(SLUG_SEGMENT_PATTERN.test('한글')).toBe(true);
  });

  test('matches existing ASCII slug shapes', () => {
    expect(SLUG_SEGMENT_PATTERN.test('hello-world')).toBe(true);
    expect(SLUG_SEGMENT_PATTERN.test('companies/acme.io')).toBe(true);
    expect(SLUG_SEGMENT_PATTERN.test('people/foo_bar')).toBe(true);
  });

  test('matches mixed CJK + ASCII', () => {
    expect(SLUG_SEGMENT_PATTERN.test('icp-理想客户画像')).toBe(true);
  });

  test('REGRESSION: rejects non-CJK Unicode (Vietnamese)', () => {
    // Scope is CJK only; Vietnamese with combining diacritics stays rejected
    // until we widen to Unicode property escapes in v0.33+.
    const result = 'người-dùng'.match(new RegExp(`^${SLUG_SEGMENT_PATTERN.source}$`));
    expect(result).toBeNull();
  });
});
